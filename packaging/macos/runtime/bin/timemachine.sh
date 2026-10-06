# shellcheck shell=bash
# Time Machine's exclusion as tmutil addexclusion leaves it: this extended attribute, holding a binary
# plist of "com.apple.backupd". Written directly with xattr -wx, since tmutil takes some 11 seconds a
# path. Sourced by postinstall and stuga.
# shellcheck disable=SC2034 # used where it is sourced
TM_EXCLUDE_ATTR=com.apple.metadata:com_apple_backup_excludeItem
# shellcheck disable=SC2034
TM_EXCLUDE_VALUE=62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c
