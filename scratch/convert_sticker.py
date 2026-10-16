import sys
from PIL import Image, ImageOps
import numpy as np

def make_transparent(input_path, output_path, tolerance=15):
    img = Image.open(input_path).convert("RGBA")
    
    # We floodfill from corners to only remove outside white, keeping any white inside the sticker intact!
    # Convert to grayscale for boundary check
    gray = ImageOps.grayscale(img)
    arr = np.array(img)
    
    # Simple and robust: floodfill mask from (0,0), (w-1,0), (0,h-1), (w-1,h-1)
    # Using PIL's floodfill on a mask
    mask = Image.new("L", img.size, 0)
    # Pixels where R, G, B are all > 245
    r, g, b, a = img.split()
    is_white = (np.array(r) >= 242) & (np.array(g) >= 242) & (np.array(b) >= 242)
    white_img = Image.fromarray((is_white * 255).astype(np.uint8))
    
    # Use BFS flood fill from corner points on white_img
    from collections import deque
    w, h = img.size
    visited = np.zeros((h, w), dtype=bool)
    q = deque()
    
    # Seed border pixels that are white
    for x in range(w):
        if is_white[0, x]: q.append((0, x)); visited[0, x] = True
        if is_white[h-1, x]: q.append((h-1, x)); visited[h-1, x] = True
    for y in range(h):
        if is_white[y, 0]: q.append((y, 0)); visited[y, 0] = True
        if is_white[y, w-1]: q.append((y, w-1)); visited[y, w-1] = True
        
    while q:
        cy, cx = q.popleft()
        for dy, dx in [(-1,0), (1,0), (0,-1), (0,1)]:
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx]:
                if is_white[ny, nx]:
                    visited[ny, nx] = True
                    q.append((ny, nx))
                    
    # Visited pixels are the outside background
    # Set alpha of outside pixels to 0 with slight smoothing
    alpha = np.ones((h, w), dtype=np.uint8) * 255
    alpha[visited] = 0
    
    # Soften edge by 1px
    alpha_img = Image.fromarray(alpha, mode='L')
    # Auto-crop transparent borders
    img.putalpha(alpha_img)
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
        
    img.save(output_path, "PNG")
    print(f"Successfully saved {output_path} with size {img.size}")

if __name__ == "__main__":
    if len(sys.argv) > 2:
        make_transparent(sys.argv[1], sys.argv[2])
    else:
        print("Usage: convert_sticker.py <in> <out>")
