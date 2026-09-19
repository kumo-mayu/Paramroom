# 同じビット数での見比べ（docs/research/12）

シミュレーション。各方式で「そのビット数以下で MS-SSIM(YCbCr) が最良の設定」の復元画像。
`sheet.png` は左から: 元画像, dctc (chunk-packed), dctc (chunk-packed, 4:4:4), wavelet97 (4:4:4), bc1 (4x4,565,2bit=4bpp), blk (8x8,565,2bit=2.5bpp), pal-global, raw-ycc420-6.5, prim-ellipse (1024, C#)（256×256 の切り出し、等倍）。

## 0.5 bpp

### kodim23

| 方式 | 設定 | bpp | MS-SSIM(YCbCr) | PSNR |
|---|---|---:|---:|---:|
| dctc (chunk-packed) | {"s":1,"quality":40,"mode":"dctc"} | 0.468 | 0.9855 | 34.43 |
| dctc (chunk-packed, 4:4:4) | {"s":1,"quality":30,"mode":"dctc","chroma":444} | 0.490 | 0.9827 | 34.28 |
| wavelet97 (4:4:4) | {"s":1,"step":20,"cq":1.5,"chroma":444} | 0.405 | 0.9864 | 36.19 |
| bc1 (4x4,565,2bit=4bpp) | このビット数では作れない | | | |
| blk (8x8,565,2bit=2.5bpp) | {"s":0.375,"bs":8,"ep":[5,6,5],"ib":2} | 0.352 | 0.9568 | 28.52 |
| pal-global | このビット数では作れない | | | |
| raw-ycc420-6.5 | このビット数では作れない | | | |
| prim-ellipse (1024, C#) | {"n":2000} | 0.300 | 0.9693 | 32.62 |

### illust_wikipetan_face

| 方式 | 設定 | bpp | MS-SSIM(YCbCr) | PSNR |
|---|---|---:|---:|---:|
| dctc (chunk-packed) | {"s":1,"quality":50,"mode":"dctc"} | 0.489 | 0.9955 | 34.93 |
| dctc (chunk-packed, 4:4:4) | {"s":1,"quality":30,"mode":"dctc","chroma":444} | 0.460 | 0.9958 | 33.78 |
| wavelet97 (4:4:4) | {"s":1,"step":28,"cq":1.5,"chroma":444} | 0.413 | 0.9922 | 35.66 |
| bc1 (4x4,565,2bit=4bpp) | このビット数では作れない | | | |
| blk (8x8,565,2bit=2.5bpp) | {"s":0.375,"bs":8,"ep":[5,6,5],"ib":2} | 0.352 | 0.9809 | 26.78 |
| pal-global | このビット数では作れない | | | |
| raw-ycc420-6.5 | このビット数では作れない | | | |
| prim-ellipse (1024, C#) | {"n":4000} | 0.256 | 0.9972 | 34.67 |

### screenshot_mahara

| 方式 | 設定 | bpp | MS-SSIM(YCbCr) | PSNR |
|---|---|---:|---:|---:|
| dctc (chunk-packed) | {"s":1,"quality":20,"mode":"dctc"} | 0.398 | 0.9833 | 28.17 |
| dctc (chunk-packed, 4:4:4) | {"s":1,"quality":20,"mode":"dctc","chroma":444} | 0.464 | 0.9871 | 28.53 |
| wavelet97 (4:4:4) | {"s":1,"step":40,"cq":1.5,"chroma":444} | 0.490 | 0.9838 | 30.44 |
| bc1 (4x4,565,2bit=4bpp) | このビット数では作れない | | | |
| blk (8x8,565,2bit=2.5bpp) | {"s":0.375,"bs":8,"ep":[5,6,5],"ib":2} | 0.354 | 0.9585 | 23.15 |
| pal-global | このビット数では作れない | | | |
| raw-ycc420-6.5 | このビット数では作れない | | | |
| prim-ellipse (1024, C#) | {"n":4000} | 0.290 | 0.9765 | 25.93 |

## 1 bpp

### kodim23

| 方式 | 設定 | bpp | MS-SSIM(YCbCr) | PSNR |
|---|---|---:|---:|---:|
| dctc (chunk-packed) | {"s":1,"quality":70,"mode":"dctc"} | 0.782 | 0.9930 | 36.76 |
| dctc (chunk-packed, 4:4:4) | {"s":1,"quality":70,"mode":"dctc","chroma":444} | 0.994 | 0.9945 | 38.06 |
| wavelet97 (4:4:4) | {"s":1,"step":10,"cq":1.5,"chroma":444} | 0.745 | 0.9935 | 39.50 |
| bc1 (4x4,565,2bit=4bpp) | {"s":0.5,"bs":4,"ep":[5,6,5],"ib":2} | 1.000 | 0.9867 | 31.44 |
| blk (8x8,565,2bit=2.5bpp) | {"s":0.625,"bs":8,"ep":[5,6,5],"ib":2} | 0.977 | 0.9801 | 31.59 |
| pal-global | {"s":0.5,"P":16,"dither":0} | 1.001 | 0.9010 | 26.46 |
| raw-ycc420-6.5 | このビット数では作れない | | | |
| prim-ellipse (1024, C#) | {"n":4000} | 0.601 | 0.9824 | 34.57 |

### illust_wikipetan_face

| 方式 | 設定 | bpp | MS-SSIM(YCbCr) | PSNR |
|---|---|---:|---:|---:|
| dctc (chunk-packed) | {"s":1,"quality":85,"mode":"dctc"} | 0.877 | 0.9983 | 39.35 |
| dctc (chunk-packed, 4:4:4) | {"s":1,"quality":80,"mode":"dctc","chroma":444} | 0.934 | 0.9991 | 40.00 |
| wavelet97 (4:4:4) | {"s":1,"step":10,"cq":1.5,"chroma":444} | 0.832 | 0.9983 | 42.07 |
| bc1 (4x4,565,2bit=4bpp) | {"s":0.5,"bs":4,"ep":[5,6,5],"ib":2} | 1.000 | 0.9953 | 29.69 |
| blk (8x8,565,2bit=2.5bpp) | {"s":0.625,"bs":8,"ep":[5,6,5],"ib":2} | 0.977 | 0.9944 | 30.56 |
| pal-global | {"s":0.5,"P":16,"dither":0} | 1.000 | 0.9942 | 29.97 |
| raw-ycc420-6.5 | このビット数では作れない | | | |
| prim-ellipse (1024, C#) | {"n":8000} | 0.512 | 0.9981 | 35.50 |

### screenshot_mahara

| 方式 | 設定 | bpp | MS-SSIM(YCbCr) | PSNR |
|---|---|---:|---:|---:|
| dctc (chunk-packed) | {"s":1,"quality":70,"mode":"dctc"} | 0.896 | 0.9916 | 31.47 |
| dctc (chunk-packed, 4:4:4) | {"s":1,"quality":60,"mode":"dctc","chroma":444} | 0.954 | 0.9951 | 32.56 |
| wavelet97 (4:4:4) | {"s":1,"step":20,"cq":1.5,"chroma":444} | 0.864 | 0.9940 | 34.63 |
| bc1 (4x4,565,2bit=4bpp) | {"s":0.5,"bs":4,"ep":[5,6,5],"ib":2} | 1.001 | 0.9783 | 24.87 |
| blk (8x8,565,2bit=2.5bpp) | {"s":0.625,"bs":8,"ep":[5,6,5],"ib":2} | 0.989 | 0.9802 | 25.76 |
| pal-global | {"s":0.5,"P":16,"dither":0} | 1.002 | 0.9762 | 24.91 |
| raw-ycc420-6.5 | このビット数では作れない | | | |
| prim-ellipse (1024, C#) | {"n":8000} | 0.581 | 0.9856 | 27.72 |

