#!/bin/sh
# nightly-backup.sh — one dated restore point a night, kept for a fortnight.
#
# Run from cron on the server:
#   0 1 * * *  /bin/sh /root/fmss-contracts/scripts/nightly-backup.sh
#
# Writes TWO files per night, because they fail differently:
#
#   data/backups/fmss-<date>.json   the app's own backup — what a restore reads
#   data/backups/fmss-<date>.db     the database itself, for a straight swap
#
# The .db is made with VACUUM INTO rather than cp. The live database is in WAL
# mode, so the most recent writes are sitting in fmss.db-wal and a copy of
# fmss.db alone is quietly stale — which is the worst possible property in a
# backup, because it looks fine until the day you need it.
#
# THE ORDER HERE IS THE POINT. Nothing old is deleted until the new snapshot
# exists AND has passed SQLite's integrity check. A prune that runs before its
# replacement is verified is how a bad night takes the good nights with it.
#
# Dates are the club's own (Asia/Dubai), not the server's UTC, so a file called
# fmss-2026-09-21 is the state on the 21st as anybody in the club would mean it.
set -eu

# These files carry PINs and password hashes. 077 keeps them to root.
umask 077

APP="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP/data/backups"
LOG="$OUT/nightly.log"
KEEP=14

DAY=$(TZ=Asia/Dubai date +%F)
NOW=$(TZ=Asia/Dubai date '+%Y-%m-%d %H:%M %Z')

mkdir -p "$OUT"
say() { echo "$NOW  $*" >>"$LOG"; }

cd "$APP"

# ---- 1. the backup a restore actually reads
if ! node scripts/backup.js export --out "$OUT/fmss-$DAY.json" >/dev/null 2>>"$LOG"; then
  say "FAILED: json export — nothing pruned"
  exit 1
fi

# ---- 2. the database file, consistent
# Written to a temporary name first: VACUUM INTO refuses an existing target, so
# a second run on the same day would otherwise fail and leave the day's .db as
# whatever the earlier run produced, with no sign that the later one did not.
tmp="$OUT/.fmss-$DAY.db.part"
rm -f "$tmp"
if ! sqlite3 "$APP/data/fmss.db" "VACUUM INTO '$tmp'" 2>>"$LOG"; then
  say "FAILED: vacuum — nothing pruned"
  rm -f "$tmp"
  exit 1
fi

# ---- 3. prove it before trusting it
if [ "$(sqlite3 "$tmp" 'PRAGMA integrity_check;')" != "ok" ]; then
  say "FAILED: the new snapshot did not pass integrity check — nothing pruned"
  rm -f "$tmp"
  exit 1
fi
mv -f "$tmp" "$OUT/fmss-$DAY.db"

rows=$(sqlite3 "$OUT/fmss-$DAY.db" 'SELECT (SELECT COUNT(*) FROM players)||" players, "
  ||(SELECT COUNT(*) FROM gameweeks)||" games, "
  ||(SELECT COUNT(*) FROM charges)||" charges, "
  ||(SELECT COUNT(*) FROM contributions)||" payments"')
say "ok  fmss-$DAY  ($rows)"

# ---- 4. and only now, the old ones
# Newest-first by modification time, keep $KEEP, delete the rest. By time
# rather than by name so the older long-stamped files age out on the same
# rule, without the script having to know two naming schemes.
for ext in json db; do
  ls -1t "$OUT"/fmss-*."$ext" 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" && say "pruned $(basename "$old")"
  done
done

# The log is the only record that any of this happened, so it is kept — but
# not for ever.
tail -n 400 "$LOG" >"$LOG.part" && mv -f "$LOG.part" "$LOG"
