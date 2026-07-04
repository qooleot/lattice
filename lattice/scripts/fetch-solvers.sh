#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor

# 1. JDK 17+ (host has Java 8 — too old for Alloy 6.2 / Apalache)
#    Prefer a system JDK 17+ via java_home. If absent, and no admin rights are
#    available to install one (e.g. `brew install --cask temurin@21` needs sudo),
#    fall back to a no-admin local JDK unpacked into vendor/jdk/ (gitignored).
#
#    NOTE: /usr/libexec/java_home's `-v 17+` filter is not trustworthy on every
#    macOS build — on hosts with only a JDK 8 installed it has been observed to
#    return the JDK 8 path anyway (ignoring the version filter entirely, even
#    for `-v 99+`). So every candidate is re-verified by actually running
#    `java -version` and parsing the major version, instead of trusting
#    java_home's exit code.
JDK_VENDOR_DIR="vendor/jdk"

java_major_version() {
  # Prints the major version of the java binary at $1 (0 if unusable).
  local out
  out="$("$1" -version 2>&1 || true)"
  if [[ "$out" =~ version\ \"1\.([0-9]+)\. ]]; then
    echo "${BASH_REMATCH[1]}"   # old scheme: 1.8.x -> 8
  elif [[ "$out" =~ version\ \"([0-9]+)\. ]]; then
    echo "${BASH_REMATCH[1]}"   # 9+ scheme: 21.0.x -> 21
  else
    echo 0
  fi
}

JAVA_CANDIDATE=""
if SYS_HOME="$(/usr/libexec/java_home -v 17+ 2>/dev/null)"; then
  if [ "$(java_major_version "$SYS_HOME/bin/java")" -ge 17 ]; then
    JAVA_CANDIDATE="$SYS_HOME/bin/java"
  fi
fi

if [ -n "$JAVA_CANDIDATE" ]; then
  echo "JDK: $JAVA_CANDIDATE (system, verified >=17 via java -version)"
elif compgen -G "$JDK_VENDOR_DIR"/*/Contents/Home/bin/java >/dev/null 2>&1; then
  echo "JDK: local vendor copy already present in $JDK_VENDOR_DIR"
else
  echo ">> No verified JDK 17+ found (java_home's version filter is unreliable on this host)."
  echo ">> Trying 'brew install --cask temurin@21' (requires admin rights)..."
  if brew install --cask temurin@21 >/tmp/fetch-solvers-brew.log 2>&1 \
      && BREW_HOME="$(/usr/libexec/java_home -v 17+ 2>/dev/null)" \
      && [ "$(java_major_version "$BREW_HOME/bin/java")" -ge 17 ]; then
    echo "JDK: $BREW_HOME/bin/java"
  else
    echo ">> brew cask install failed or unverified (likely needs sudo password in this non-interactive environment)."
    echo ">> Falling back to a no-admin local JDK download (Temurin 21, macOS aarch64)."
    mkdir -p "$JDK_VENDOR_DIR"
    ARCHIVE="$JDK_VENDOR_DIR/temurin21.tar.gz"
    if ! compgen -G "$JDK_VENDOR_DIR"/jdk-21*/Contents/Home >/dev/null 2>&1; then
      curl -fL -o "$ARCHIVE" \
        "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.11_10.tar.gz"
      tar -xzf "$ARCHIVE" -C "$JDK_VENDOR_DIR"
      rm -f "$ARCHIVE"
    fi
    JAVA_BIN=("$JDK_VENDOR_DIR"/*/Contents/Home/bin/java)
    echo "JDK: ${JAVA_BIN[0]} (local vendor copy, no admin rights required, verified major $(java_major_version "${JAVA_BIN[0]}"))"
  fi
fi

# 2. Alloy 6.2 dist jar
if [ ! -f vendor/alloy.jar ]; then
  curl -fL -o vendor/alloy.jar \
    "https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v6.2.0/org.alloytools.alloy.dist.jar"
fi
echo "Alloy jar: $(ls -lh vendor/alloy.jar | awk '{print $5}')"

# 3. Quint is an npm dep (installed already); Apalache is auto-fetched by `quint verify` on first use.
npx quint --version
echo "OK — run 'npx tsx src/solvers/doctor.ts' to verify."
