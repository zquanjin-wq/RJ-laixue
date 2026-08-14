#!/usr/bin/env sh
# Invoke one durable course-revoice work batch. Intended for a trusted external
# scheduler (for example an EdgeOne CVM systemd timer), not browser clients.
set -eu

: "${COURSE_REVOICE_URL:?Set COURSE_REVOICE_URL, e.g. https://www.laixue.work/api/cron/course-revoice}"
: "${CRON_SECRET:?Set CRON_SECRET}"

curl --fail --silent --show-error --max-time 290 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${COURSE_REVOICE_URL}"
