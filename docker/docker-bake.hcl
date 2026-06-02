variable "PLATFORM" {
  default = ""
}

target "test-e2e" {
  dockerfile = "docker/Dockerfile.e2e"
  context    = "."
  target     = "verify"
  platforms  = PLATFORM != "" ? [PLATFORM] : null
}

target "shell" {
  dockerfile = "docker/Dockerfile.e2e"
  context    = "."
  target     = "runner"
  tags       = ["monad-shell:dev"]
  platforms  = PLATFORM != "" ? [PLATFORM] : null
}

# Builds the runner image (no build-time gate) for the LIVE real-model e2e. The secret API key is
# injected at `docker run` time, not here — see `mise run docker:test:e2e:live`.
target "test-e2e-live" {
  dockerfile = "docker/Dockerfile.e2e"
  context    = "."
  target     = "runner"
  tags       = ["monad-e2e-live:dev"]
  platforms  = PLATFORM != "" ? [PLATFORM] : null
}

target "test-e2e-deps" {
  dockerfile = "docker/Dockerfile.e2e-deps"
  context    = "."
  platforms  = PLATFORM != "" ? [PLATFORM] : null
}

target "test-install" {
  dockerfile = "docker/Dockerfile.test"
  context    = "."
  platforms  = PLATFORM != "" ? [PLATFORM] : null
}

target "test-install-musl" {
  dockerfile = "docker/Dockerfile.musl-test"
  context    = "."
  platforms  = PLATFORM != "" ? [PLATFORM] : null
}

# Runs the cross-platform / native-cli bun test suite (incl. *.linux.test.ts) on Linux.
target "test-unit" {
  dockerfile = "docker/Dockerfile.unit-test"
  context    = "."
  platforms  = PLATFORM != "" ? [PLATFORM] : null
}
