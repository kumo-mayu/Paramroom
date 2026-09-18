#!/usr/bin/env bash
# Runs simulation jobs on the second PC (Ryzen 7 5700X, 16 threads) over SSH and brings the results back.
# The second PC keeps a copy of sim/ at C:\paramroom-sim (set PARAMROOM_REMOTE_DIR to use another folder);
# only the scripts and the produced cache files move.
#
#   bash remote.sh sync                 # push the scripts (codecs/, lib/, *.js) to the second PC
#   bash remote.sh run <jobs file>      # run the jobs there (one per line, e.g. "shape-eval.js encode kodim23 rf")
#   bash remote.sh fetch <glob>         # copy cache files back, e.g. 'cache/shape/*-rf4.json'
set -e
HOST=${PARAMROOM_REMOTE:-kaito@192.168.2.100}
RDIR=${PARAMROOM_REMOTE_DIR:-C:/paramroom-sim}
RDIRW=${RDIR//\//\\}   # the same path with backslashes, which is what cmd.exe wants
WORKERS=${PARAMROOM_REMOTE_WORKERS:-16}
cd "$(dirname "$0")"

case "$1" in
  sync)
    tar czf /tmp/simsync.tgz codecs lib *.js package.json
    scp -q /tmp/simsync.tgz "$HOST:$RDIR/"
    ssh "$HOST" "cd /d $RDIRW && tar xzf simsync.tgz && del simsync.tgz"
    echo "synced scripts to $HOST"
    ;;
  run)
    [ -n "$2" ] || { echo "usage: remote.sh run <jobs file>"; exit 1; }
    scp -q "$2" "$HOST:$RDIR/jobs.txt"
    # the study variables are passed through (canvas size and packet budget), so the same jobs file works on both machines
    ssh "$HOST" "cd /d $RDIRW && set PARAMROOM_R=${PARAMROOM_R:-512}&& set PARAMROOM_UNITS=${PARAMROOM_UNITS:-1000}&& node run-jobs.js $WORKERS jobs.txt"
    ;;
  fetch)
    [ -n "$2" ] || { echo "usage: remote.sh fetch <glob under the remote sim dir>"; exit 1; }
    mkdir -p "$(dirname "$2")"
    scp -q "$HOST:$RDIR/$2" "$(dirname "$2")/"
    echo "fetched $2"
    ;;
  *)
    echo "usage: remote.sh sync|run <jobs file>|fetch <glob>"
    exit 1
    ;;
esac
