package main

import (
	"errors"
	"image"
	"runtime"

	"github.com/kirides/go-d3d/d3d11"
	"github.com/kirides/go-d3d/outputduplication"
	"github.com/nomadvnc/nomadvnc/go-core/internal/rfb"
)

// BitBlt on Windows 10 and 11 often returns only the wallpaper, and
// PrintWindow cannot read a window running at a higher integrity level
// than the screen helper. Desktop duplication is the composed image, so
// the setup window and ordinary programs both show up.

type captureResult struct {
	frame rfb.Frame
	err   error
}

var captureReq chan chan captureResult

func startCaptureWorker() {
	if captureReq != nil {
		return
	}
	captureReq = make(chan chan captureResult)
	go func() {
		runtime.LockOSThread()
		for resp := range captureReq {
			frame, err := captureOnWorkerThread()
			resp <- captureResult{frame: frame, err: err}
		}
	}()
}

func captureScreen() (rfb.Frame, error) {
	if captureReq == nil {
		return captureGDI()
	}
	resp := make(chan captureResult, 1)
	captureReq <- resp
	result := <-resp
	return result.frame, result.err
}

var (
	dxgiDup    *outputduplication.OutputDuplicator
	dxgiDevice *d3d11.ID3D11Device
	dxgiCtx    *d3d11.ID3D11DeviceContext
	dxgiBroken bool
	dxgiLogged bool
	lastDXGI   rfb.Frame
)

func captureOnWorkerThread() (rfb.Frame, error) {
	frame, err := captureDXGI()
	if err == nil {
		if !dxgiLogged {
			dxgiLogged = true
			logf("screen capture using desktop duplication")
		}
		return frame, nil
	}
	if !dxgiLogged {
		dxgiLogged = true
		logf("desktop duplication unavailable (%v); using window capture", err)
	}
	return captureGDI()
}

func captureDXGI() (rfb.Frame, error) {
	if dxgiBroken {
		return rfb.Frame{}, errors.New("desktop duplication unavailable")
	}
	if dxgiDup == nil {
		device, ctx, err := d3d11.NewD3D11Device()
		if err != nil {
			dxgiBroken = true
			return rfb.Frame{}, err
		}
		dup, err := outputduplication.NewIDXGIOutputDuplication(device, ctx, 0)
		if err != nil {
			device.Release()
			ctx.Release()
			dxgiBroken = true
			return rfb.Frame{}, err
		}
		dup.DrawPointer = true
		dup.UpdatePointerInfo = true
		dxgiDevice = device
		dxgiCtx = ctx
		dxgiDup = dup
	}

	bounds, err := dxgiDup.GetBounds()
	if err != nil || bounds.Dx() < 640 || bounds.Dy() < 480 {
		resetDXGI()
		if err == nil {
			err = errors.New("desktop duplication returned no usable image")
		}
		return rfb.Frame{}, err
	}
	img := image.NewRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	err = dxgiDup.GetImage(img, 200)
	if errors.Is(err, outputduplication.ErrNoImageYet) {
		// Duplication waits for the next change. Nudge the pointer so the
		// first image includes the desktop as it is right now.
		nudgeCursor()
		err = dxgiDup.GetImage(img, 1000)
	}
	if errors.Is(err, outputduplication.ErrNoImageYet) && len(lastDXGI.Pix) > 0 {
		return lastDXGI, nil
	}
	if err != nil {
		if errors.Is(err, outputduplication.ErrNoImageYet) && len(lastDXGI.Pix) > 0 {
			return lastDXGI, nil
		}
		resetDXGI()
		return rfb.Frame{}, err
	}
	frame := rgbaToBGRA(img)
	lastDXGI = frame
	return frame, nil
}

func resetDXGI() {
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
	sendMouse(mouseInput{Type: inputMouse, Dx: 1, Flags: mouseEventMove})
	sendMouse(mouseInput{Type: inputMouse, Dx: -1, Flags: mouseEventMove})
}

func rgbaToBGRA(img *image.RGBA) rfb.Frame {
	pix := make([]byte, len(img.Pix))
	for i := 0; i < len(img.Pix); i += 4 {
		pix[i] = img.Pix[i+2]
		pix[i+1] = img.Pix[i+1]
		pix[i+2] = img.Pix[i]
		pix[i+3] = 255
	}
	return rfb.Frame{Width: img.Rect.Dx(), Height: img.Rect.Dy(), Pix: pix}
}
