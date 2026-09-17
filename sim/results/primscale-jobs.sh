#!/bin/sh
# Run the prim scaling study (encode + eval) for all test images, R 256/512, n 1000/2000/4000, 14 parallel jobs.
cd "$(dirname "$0")/.."
for R in 512 256; do for n in 4000 2000 1000; do for f in images/ref/*.png; do echo "$(basename $f .png) $R $n"; done; done; done |
  xargs -P 14 -L 1 sh -c 'node prim-scale.js encode $0 $1 $2 && node prim-scale.js eval $0 $1 $2'
node prim-scale.js summary > /dev/null
echo done
