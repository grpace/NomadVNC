package main

import (
	"errors"
	"reflect"
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

	var (
		frame rfb.Frame
		err   error
	)
	if len(lastDXGI.Pix) == 0 && !dxgiWaited {
		dxgiWaited = true
		frame, err = firstDXGIImage()
	} else {
		// Don't wait: connections poll every frame, and a wait here would
		// hold up every connection's next check.
		frame, err = grabDXGI(0)
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
func firstDXGIImage() (rfb.Frame, error) {
	deadline := time.Now().Add(firstImageWait)
	nudged := false
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return rfb.Frame{}, outputduplication.ErrNoImageYet
		}
		if !nudged {
			left = min(left, 200*time.Millisecond)
		}
		asked := time.Now()
		frame, err := grabDXGI(uint(left.Milliseconds()) + 1)
		if !errors.Is(err, outputduplication.ErrNoImageYet) {
			return frame, err
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

// grabDXGI returns the next image from the duplication, waiting up to
// timeoutMs for one.
//
// The size is the captured image's own, never the output's desktop
// coordinates. Those are in the units of the DPI the helper started
// with, so after a change to the display scale they no longer match the
// image, and a buffer sized from them gets each row wrapped across two.
func grabDXGI(timeoutMs uint) (rfb.Frame, error) {
	unmap, mapped, size, err := dxgiDup.Snapshot(timeoutMs)
	if err != nil {
		return rfb.Frame{}, err
	}
	defer unmap()
	width, height, pitch := int(size.X), int(size.Y), int(mapped.Pitch)
	if width < 640 || height < 480 || pitch < width*4 {
		return rfb.Frame{}, errors.New("desktop duplication returned no usable image")
	}
	data := unsafe.Slice((*byte)(mapped.PBits), pitch*height)
	pix := make([]byte, width*height*4)
	rowBytes := width * 4
	for y := 0; y < height; y++ {
		copy(pix[y*rowBytes:(y+1)*rowBytes], data[y*pitch:])
	}
	if !dxgiDataIsBGRA() {
		// Swaps red and blue in place. The fourth byte of each pixel is
		// padding and is left as it is.
		swizzle.BGRA(pix)
	}
	return rfb.Frame{Width: width, Height: height, Pix: pix}, nil
}

// dxgiDataIsBGRA reports the byte order of Snapshot's data: BGRA when the
// duplication fell back to DuplicateOutput, else the RGBA asked of
// DuplicateOutput1. go-d3d (pinned at v1.0.1) keeps this in an unexported
// field that its own GetImage reads, and the field can change with any
// frame, so it is read after each Snapshot.
func dxgiDataIsBGRA() bool {
	field := reflect.ValueOf(dxgiDup).Elem().FieldByName("needsSwizzle")
	return field.IsValid() && field.Bool()
}
