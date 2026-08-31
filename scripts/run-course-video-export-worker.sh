#!/usr/bin/env sh
set -eu

: "${COURSE_VIDEO_EXPORT_URL:?Set COURSE_VIDEO_EXPORT_URL}"
: "${CRON_SECRET:?Set CRON_SECRET}"

curl --fail --silent --show-error --max-time 290 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${COURSE_VIDEO_EXPORT_URL}"
