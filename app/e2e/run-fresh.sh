#!/bin/sh
# One fresh browser (and so one fresh AudioEngine) per recording, real time, for the in-app audio control stream.
# usage: PREVIEW_URL=http://localhost:4617 sh app/e2e/run-fresh.sh [tagprefix]   (skips recordings already done)
P=${1:-fresh2}
for n in $(python3 -c "import json;print(' '.join(json.load(open('app/e2e/out/recordings/index.json'))))"); do
  [ -f app/e2e/out/${P}_$n/results.json ] && continue
  node app/e2e/fake-test.mjs --speed 1 --only $n --tag ${P}_$n || node app/e2e/fake-test.mjs --speed 1 --only $n --tag ${P}_$n
done
echo ALLDONE
