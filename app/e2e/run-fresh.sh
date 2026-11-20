#!/bin/sh
# One fresh browser (and so one fresh AudioEngine) per recording, real time, for valid in-app audio capture.
# usage: PREVIEW_URL=http://localhost:4391 sh app/e2e/run-fresh.sh
for n in phi3_10db phi5_15db octave3_10db background_only white_noise random_bands harmonic_8hz artifact_blinks artifact_jaw_clench nearmiss_1.8_10db phi3_10db_shuffled_samples phi3_10db_shuffled_2s_blocks; do
  node app/e2e/fake-test.mjs --speed 1 --only $n --tag fresh_$n
done
echo done
