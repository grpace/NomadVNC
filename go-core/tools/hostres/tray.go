package main

import (
	"image"
	"image/color"
	"math"

	"github.com/tc-hib/winres"
)

// TrayIconID is the resource ID of the system tray icon.
const TrayIconID = 2

// The app's logo is a line drawing, which turns to a gray smudge at the
// 16 pixels a tray icon gets. This is the same idea cut down to what
// survives that size: the shield, in the app's blue, with the hooded
// figure as a plain white head and shoulders.

var (
	trayBlue  = color.NRGBA{0x0A, 0x6C, 0xFF, 0xFF}
	trayWhite = color.NRGBA{0xFF, 0xFF, 0xFF, 0xFF}
)

// inShield reports whether (x, y), each from 0 to 1, is inside the shield:
// straight sides, then a curve in to a point at the bottom.
func inShield(x, y float64) bool {
	const top, shoulder, tip, half = 0.07, 0.50, 0.95, 0.40
	if y < top || y > tip {
		return false
	}
	w := half
	if y > shoulder {
		t := (y - shoulder) / (tip - shoulder)
		w = half * (1 - math.Pow(t, 1.9))
	}
	return math.Abs(x-0.5) <= w
}

// inFigure reports whether the point is on the head or the shoulders.
func inFigure(x, y float64) bool {
	if math.Hypot(x-0.5, y-0.34) <= 0.125 {
		return true
	}
	dx, dy := (x-0.5)/0.235, (y-0.74)/0.22
	return y <= 0.72 && dx*dx+dy*dy <= 1
}

// trayImage draws the icon at size pixels, each pixel averaged from an
// 8 by 8 grid of samples so the edges are smooth.
func trayImage(size int) image.Image {
	const grid = 8
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var blue, white int
			for sy := 0; sy < grid; sy++ {
				for sx := 0; sx < grid; sx++ {
					x := (float64(px) + (float64(sx)+0.5)/grid) / float64(size)
					y := (float64(py) + (float64(sy)+0.5)/grid) / float64(size)
					switch {
					case !inShield(x, y):
					case inFigure(x, y):
						white++
					default:
						blue++
					}
				}
			}
			covered := blue + white
			if covered == 0 {
				continue
			}
			mix := func(b, w uint8) uint8 {
				return uint8((int(b)*blue + int(w)*white) / covered)
			}
			img.SetNRGBA(px, py, color.NRGBA{
				R: mix(trayBlue.R, trayWhite.R),
				G: mix(trayBlue.G, trayWhite.G),
				B: mix(trayBlue.B, trayWhite.B),
				A: uint8(covered * 255 / (grid * grid)),
			})
		}
	}
	return img
}

// trayIcon is the icon at the sizes Windows asks for at 100% to 300%
// display scaling.
func trayIcon() (*winres.Icon, error) {
	var images []image.Image
	for _, size := range []int{16, 20, 24, 32, 40, 48, 64} {
		images = append(images, trayImage(size))
	}
	return winres.NewIconFromImages(images)
}
