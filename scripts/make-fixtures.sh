#!/bin/sh
# Synthetic test songs with known structure (needs ffmpeg).
# song120: 160 s at 120 BPM. Quiet intro 0-20, verse (A minor, quiet) 20-50 and 80-110,
# chorus (F major, loud, with noise hats) 50-80 and 110-140, outro 140-160. Kick every 0.5 s.
set -e
mkdir -p "$(dirname "$0")/../test/fixtures"
cd "$(dirname "$0")/../test/fixtures"
CHORUS='(between(t,50,80)+between(t,110,140))*(0.6*(sin(2*PI*349*t)+sin(2*PI*440*t)+sin(2*PI*523*t))/3+0.12*(2*random(0)-1)*exp(-20*mod(t+0.25,0.5)))'
VERSE='(between(t,20,50)+between(t,80,110))*0.2*(sin(2*PI*220*t)+sin(2*PI*262*t)+sin(2*PI*330*t))/3'
INTRO='(lt(t,20)+gt(t,140))*0.05*sin(2*PI*196*t)'
KICK='0.5*exp(-30*mod(t,0.5))*sin(2*PI*60*t)'
ffmpeg -loglevel error -y -f lavfi -i "aevalsrc='$CHORUS+$VERSE+$INTRO+$KICK':s=22050:d=160" -ac 1 -q:a 4 song120.mp3
ffmpeg -loglevel error -y -i song120.mp3 -c:a aac -b:a 128k song120.m4a
ffmpeg -loglevel error -y -f lavfi -i "anoisesrc=color=pink:amplitude=0.3:d=90:r=22050" -ac 1 -q:a 4 pink.mp3
echo "fixtures written to $(pwd)"
