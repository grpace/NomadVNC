package main

import (
	"errors"
	"image"
	"time"
	"unsafe"

	"github.com/kirides/go-d3d/d3d11"
	"github.com/kirides/go-d3d/outputduplication"
	"github.com/kirides/go-d3d/outputduplication/swizzle"
	"github.com/nomadvnc/nomadvnc/go-core/internal/rfb"
)

// BitBlt on Windows 10 and 11 often returns only the wallpaper, and
// PrintWindow cannot read a window running at a higher integrity level
// than the screen helper. Desktop duplication is the composed image, so
// the setup window and ordinary programs both show up.

// captureDesk is the thread all capture runs on.
var captureDesk *deskThread

func startCaptureWorker() {
	if captureDesk != nil {
		return
	}
	captureDesk = newDeskThread(true, func() {
		// Duplication belongs to the desktop it started on. Start again
		// on the new one straight away.
		resetDXGI()
		dxgiRetryAt, dxgiFailures = time.Time{}, 0
	})
}

func captureScreen() (rfb.Frame, error) {
	if captureDesk == nil {
		return captureGDI()
	}
	var (
		frame rfb.Frame
		err   error
	)
	captureDesk.do(func() { frame, err = captureOnWorkerThread() })
	return frame, err
}

// All of this is touched only on the capture worker's thread.
var (
	dxgiDup    *outputduplication.OutputDuplicator
	dxgiDevice *d3d11.ID3D11Device
	dxgiCtx    *d3d11.ID3D11DeviceContext
	// dxgiRetryAt is when to try starting duplication again after it
	// failed, and dxgiFailures how many times in a row it has. Most
	// failures pass: Windows refuses duplication while it switches
	// desktops or display modes.
	dxgiRetryAt  time.Time
	dxgiFailures int
	// dxgiWaited is set once the current duplication has had its wait for
	// a first image.
	dxgiWaited bool
	lastDXGI   rfb.Frame
	// dxgiImage is reused for every capture; frames get their own copy.
	dxgiImage *image.RGBA
	// captureVia is the capture method last logged.
	captureVia string
	// frameSeq numbers distinct images (rfb.Frame.Seq).
	frameSeq  uint64
	lastGDI   rfb.Frame
	lastGDIAt time.Time
)

const (
	// gdiInterval spaces out window captures, which copy the whole screen
	// each time: 20 a second is smooth enough for the sign-in screen.
	gdiInterval = 50 * time.Millisecond
	// dxgiRetry is the pause before starting duplication again. It
	// doubles with each failure in a row, up to dxgiRetryMax, so a PC
	// that can't duplicate at all isn't held up by attempts.
	dxgiRetry    = 500 * time.Millisecond
	dxgiRetryMax = 30 * time.Second
	// firstImageWait is how long a new duplication gets to deliver its
	// first image before window capture stands in.
	firstImageWait = 1200 * time.Millisecond
)

var errDXGIDown = errors.New("desktop duplication is not running")

// captureOnWorkerThread returns the screen without the pointer, plus the
// pointer itself, which viewers draw locally or the VNC server draws in.
func captureOnWorkerThread() (rfb.Frame, error) {
	frame, err := captureDXGI()
	if err != nil && captureDesk.follow(true) {
		// The screen moved to another desktop under the duplication.
		frame, err = captureDXGI()
	}
	if err == nil {
		noteCapture("desktop duplication", nil)
	} else {
		noteCapture("window capture", err)
		frame, err = captureGDIPaced()
		if err != nil {
			return frame, err
		}
	}
	frame.Cursor = currentPointer()
	return frame, nil
}

// noteCapture logs the capture method when it changes.
func noteCapture(via string, why error) {
	if via == captureVia {
		return
	}
	captureVia = via
	if why != nil {
		logf("screen capture using %s (desktop duplication: %v)", via, why)
		return
	}
	logf("screen capture using %s", via)
}

func captureGDIPaced() (rfb.Frame, error) {
	if len(lastGDI.Pix) > 0 && time.Since(lastGDIAt) < gdiInterval {
		return lastGDI, nil
	}
	frame, err := captureGDI()
	if err != nil {
		return frame, err
	}
	frameSeq++
	frame.Seq = frameSeq
	lastGDI, lastGDIAt = frame, time.Now()
	return frame, nil
}

func captureDXGI() (rfb.Frame, error) {
	if dxgiDup == nil {
		if time.Now().Before(dxgiRetryAt) {
			return rfb.Frame{}, errDXGIDown
		}
		if err := startDXGI(); err != nil {
			dxgiFailed()
			return rfb.Frame{}, err
		}
	}

	bounds, err := dxgiDup.GetBounds()
	if err != nil || bounds.Dx() < 640 || bounds.Dy() < 480 {
		resetDXGI()
		if err == nil {
			err = errors.New("desktop duplication returned no usable image")
		}
		return rfb.Frame{}, err
	}
	rect := image.Rect(0, 0, bounds.Dx(), bounds.Dy())
	if dxgiImage == nil || dxgiImage.Rect != rect {
		dxgiImage = image.NewRGBA(rect)
		lastDXGI = rfb.Frame{}
	}
	if len(lastDXGI.Pix) == 0 && !dxgiWaited {
		dxgiWaited = true
		err = firstDXGIImage()
	} else {
		// Don't wait: connections poll every frame, and a wait here would
		// hold up every connection's next check.
		err = dxgiDup.GetImage(dxgiImage, 0)
	}
	if errors.Is(err, outputduplication.ErrNoImageYet) {
		if len(lastDXGI.Pix) > 0 {
			return lastDXGI, nil
		}
		// Keep the duplication. Its first image, the whole screen, comes
		// with the next change; window capture stands in until then.
		return rfb.Frame{}, err
	}
	if err != nil {
		resetDXGI()
		return rfb.Frame{}, err
	}
	frame := rgbaToBGRA(dxgiImage)
	frameSeq++
	frame.Seq = frameSeq
	lastDXGI = frame
	dxgiFailures = 0
	return frame, nil
}

// dxgiFailed schedules the next attempt to start duplication.
func dxgiFailed() {
	wait := dxgiRetry << min(dxgiFailures, 6)
	dxgiFailures++
	dxgiRetryAt = time.Now().Add(min(wait, dxgiRetryMax))
}

func startDXGI() error {
	device, ctx, err := d3d11.NewD3D11Device()
	if err != nil {
		return err
	}
	dup, err := outputduplication.NewIDXGIOutputDuplication(device, ctx, 0)
	if err != nil {
		device.Release()
		ctx.Release()
		return err
	}
	// The pointer travels separately (see currentPointer), so a viewer can
	// draw it locally and a move over a still desktop needs no new image.
	dup.DrawPointer = false
	dup.UpdatePointerInfo = false
	dxgiDevice = device
	dxgiCtx = ctx
	dxgiDup = dup
	dxgiWaited = false
	lastDXGI = rfb.Frame{}
	return nil
}

// firstDXGIImage waits for a new duplication's first image. A pointer
// update also comes back as "no image yet", at once, so asking once is not
// enough: keep asking until the time is up.
func firstDXGIImage() error {
	deadline := time.Now().Add(firstImageWait)
	nudged := false
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return outputduplication.ErrNoImageYet
		}
		if !nudged {
			left = min(left, 200*time.Millisecond)
		}
		asked := time.Now()
		err := dxgiDup.GetImage(dxgiImage, uint(left.Milliseconds())+1)
		if !errors.Is(err, outputduplication.ErrNoImageYet) {
			return err
		}
		if !nudged {
			// Duplication waits for the next change. Where Windows draws
			// the pointer into the picture, moving it is one.
			nudged = true
			nudgeCursor()
		}
		if time.Since(asked) < 5*time.Millisecond {
			time.Sleep(5 * time.Millisecond)
		}
	}
}

// resetDXGI drops the duplication; captureDXGI starts a new one after a
// pause.
func resetDXGI() {
	dxgiFailed()
	dxgiImage = nil
	lastDXGI = rfb.Frame{}
	if dxgiDup != nil {
		dxgiDup.Release()
		dxgiDup = nil
	}
	if dxgiCtx != nil {
		dxgiCtx.Release()
		dxgiCtx = nil
	}
	if dxgiDevice != nil {
		dxgiDevice.Release()
		dxgiDevice = nil
	}
}

func nudgeCursor() {
	sendInput(1, unsafe.Pointer(&mouseInput{Type: inputMouse, Dx: 1, Flags: mouseEventMove}), unsafe.Sizeof(mouseInput{}))
	sendInput(1, unsafe.Pointer(&mouseInput{Type: inputMouse, Dx: -1, Flags: mouseEventMove}), unsafe.Sizeof(mouseInput{}))
}

// rgbaToBGRA gives a frame its own copy of the image with red and blue
// swapped. The fourth byte of each pixel is padding and is left as it is.
func rgbaToBGRA(img *image.RGBA) rfb.Frame {
	pix := make([]byte, len(img.Pix))
	copy(pix, img.Pix)
	swizzle.BGRA(pix) // swaps the two in place, whichever way round
	return rfb.Frame{Width: img.Rect.Dx(), Height: img.Rect.Dy(), Pix: pix}
}
