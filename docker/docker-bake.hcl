variable "PLATFORM" {
  default = ""
}

locals {
  platforms = PLATFORM != "" ? [PLATFORM] : null
}

target "test-e2e" {
  dockerfile = "docker/Dockerfile.e2e"
  context    = "."
  target     = "verify"
  platforms  = local.platforms
}

target "shell" {
  dockerfile = "docker/Dockerfile.e2e"
  context    = "."
  target     = "runner"
  tags       = ["monad-shell:dev"]
  platforms  = local.platforms
}

# Builds the runner image (no build-time gate) for the LIVE real-model e2e. The secret API key is
# injected at `docker run` time, not here — see `bun run docker:test:e2e:live`.
target "test-e2e-live" {
  dockerfile = "docker/Dockerfile.e2e"
  context    = "."
  target     = "runner"
  tags       = ["monad-e2e-live:dev"]
  platforms  = local.platforms
}

target "test-install" {
  dockerfile = "docker/Dockerfile.test"
  context    = "."
  platforms  = local.platforms
}

target "test-install-musl" {
  dockerfile = "docker/Dockerfile.musl-test"
  context    = "."
  platforms  = local.platforms
}

# Runs the cross-platform / native-cli bun test suite (incl. *.linux.test.ts) on Linux.
target "test-unit" {
  dockerfile = "docker/Dockerfile.unit-test"
  context    = "."
  platforms  = local.platforms
}
