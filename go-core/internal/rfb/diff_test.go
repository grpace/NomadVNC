package rfb

import "testing"

func TestDirtyTilesFullWhenNoPrevious(t *testing.T) {
	next := make([]byte, 2*2*4)
	tiles := DirtyTiles(nil, next, 2, 2)
	if len(tiles) != 1 {
		t.Fatalf("tiles = %d, want 1", len(tiles))
	}
	if tiles[0] != (Rect{X: 0, Y: 0, W: 2, H: 2}) {
		t.Fatalf("tile = %+v", tiles[0])
	}
}

func TestDirtyTilesQuietWhenUnchanged(t *testing.T) {
	pix := make([]byte, 80*80*4)
	if tiles := DirtyTiles(pix, append([]byte(nil), pix...), 80, 80); len(tiles) != 0 {
		t.Fatalf("unchanged frame produced %d tiles", len(tiles))
	}
}

func TestDirtyTilesOnePixel(t *testing.T) {
	prev := make([]byte, 80*80*4)
	next := append([]byte(nil), prev...)
	next[4] = 0xff
	tiles := DirtyTiles(prev, next, 80, 80)
	if len(tiles) != 1 {
		t.Fatalf("tiles = %d, want 1", len(tiles))
	}
	if tiles[0].X != 0 || tiles[0].Y != 0 {
		t.Fatalf("changed tile = %+v, want origin", tiles[0])
	}
}
