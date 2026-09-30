# shellcheck shell=bash
# Sourced by the Mac's remote-wrapper.sh and the Docker image's supervisor.sh, which start the
# connector (frpc) only from a private copy of each <relay>.toml the node wrote, and only when the
# copy passes check_config. Neither trusts the node: its config must be, byte for byte, what
# renderFrpcToml (services/node/src/remote/frpc-config.ts) writes, with every value of the shape the
# node checks it has. So no settings open an admin interface, a visitor, another plugin or a
# template, or point the connector at files outside the node's directory.

# config_dir_ok <dir>: the paths in a config are compared as the node writes them, so the directory
# must be absolute, normalized, and hold nothing its TOML strings would escape.
config_dir_ok() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    */ | *//* | */./* | */../* | */. | */.. | *[\"\\{}]* | *[[:cntrl:]]*) return 1 ;;
  esac
}

# check_config <copy> <relay> <dir>: the copy is exactly what renderFrpcToml writes for that relay
# in that directory, with each value of the shape the node checks. Sets `reason` when it is not.
# shellcheck disable=SC2034 # reason is the caller's
check_config() {
  local copy="$1" relay="$2" dir="$3"
  local label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  local node_id='[0-9bcdfghjkmnpqrstvwxz]{6,12}'
  local dns_re="^$label(\\.$label)*\$" id_re="^$node_id\$" host_re="^$node_id(\\.$label)+\$"
  local port_re='^[1-9][0-9]{0,4}$' level_re='^(info|warn)$'
  local addr port server id host level
  # The whole name, not a line of it: the relay is written into the expected text below.
  reason="the relay's name is not a relay"
  [[ $relay =~ ^[a-z0-9-]{1,32}$ ]] || return 1
  # value <sed pattern>: the first match's \1, or nothing. Every line is compared below.
  value() { sed -n "/^$1\$/{s//\\1/p;q;}" "$copy"; }
  addr="$(value 'serverAddr = "\(.*\)"')"
  port="$(value 'serverPort = \(.*\)')"
  server="$(value 'transport\.tls\.serverName = "\(.*\)"')"
  level="$(value 'log\.level = "\(.*\)"')"
  id="$(value 'name = "\(.*\)"')"
  host="$(value 'customDomains = \["\(.*\)"\]')"

  reason="serverAddr is not a host name"
  [[ $addr =~ $dns_re ]] || return 1
  reason="serverPort is not a port"
  [[ $port =~ $port_re ]] && [ "$port" -le 65535 ] || return 1
  reason="transport.tls.serverName is not a host name"
  [[ $server =~ $dns_re ]] || return 1
  reason="log.level is neither info nor warn"
  [[ $level =~ $level_re ]] || return 1
  reason="the proxy's name is not a node id"
  [[ $id =~ $id_re ]] || return 1
  reason="customDomains is not the node's own host name"
  [[ $host =~ $host_re ]] && [ "${host%%.*}" = "$id" ] || return 1

  cat > "$copy.expected" << EOF
# Written by Stuga. Changes are overwritten.
serverAddr = "$addr"
serverPort = $port
loginFailExit = false
auth.method = "oidc"
auth.additionalScopes = ["HeartBeats"]
auth.oidc.tokenSource.type = "file"
auth.oidc.tokenSource.file.path = "$dir/$relay.jwt"
transport.tls.enable = true
transport.tls.trustedCaFile = "$dir/$relay.ca.pem"
transport.tls.serverName = "$server"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90
transport.poolCount = 2
log.to = "console"
log.level = "$level"

[[proxies]]
name = "$id"
type = "https"
customDomains = ["$host"]
transport.proxyProtocolVersion = "v2"
[proxies.plugin]
type = "unix_domain_socket"
unixPath = "$dir/https.sock"
EOF
  local differ
  if ! differ="$(cmp "$copy.expected" "$copy" 2>&1)"; then
    # Where, never what: the line may hold anything.
    case "$differ" in
      *", line "*) reason="it is not the config the node writes (${differ##*, })" ;;
      *) reason="it is not the config the node writes (a line is missing or extra)" ;;
    esac
    return 1
  fi
  rm -f "$copy.expected"
}
