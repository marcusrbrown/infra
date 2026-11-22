# Traces collector: the OpenTelemetry Collector Builder compiles the components listed in
# builder-config.yaml into one static binary. CI builds this image and pushes it to GHCR; the host
# never builds it. Build context is this directory:
#
#   docker build --platform linux/amd64 -t <name> apps/traces/collector
#
# Both base images are pinned by tag and digest (Renovate moves them). The builder stage always runs
# on the build machine's own architecture and cross-compiles, so an arm64 laptop and an amd64 runner
# produce the same linux/amd64 binary without emulating the Go toolchain.
FROM --platform=$BUILDPLATFORM golang:1.26.11@sha256:4165ee6bf3b7811fd7b40373290405c83d0167dcb87ee5f29c427cdcef45ff8f AS build

# The builder and every component in builder-config.yaml share one version set; Renovate moves them
# together (.github/renovate.json5, "traces collector"), and builder-config.test.ts checks they match.
# renovate: datasource=go depName=go.opentelemetry.io/collector/cmd/builder
ARG OCB_VERSION=v0.165.0
ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src
RUN GOBIN=/usr/local/bin go install go.opentelemetry.io/collector/cmd/builder@${OCB_VERSION}
COPY builder-config.yaml ./
# CGO off: the binary is static, so the final image needs no libc and no shell.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH builder --config=builder-config.yaml --ldflags="-s -w"

FROM gcr.io/distroless/static-debian13:nonroot@sha256:8ce6dd87e9823c5b48dcfb2c8604714ccb351ce59607327bcc4957448da279b5

COPY --from=build /out/otelcol-traces /otelcol-traces
# UID 65532 is the image's built-in `nonroot` user. The queue and token directories the compose file
# mounts must be readable (tokens) and writable (queues) by it.
USER 65532:65532
ENTRYPOINT ["/otelcol-traces"]
CMD ["--config=/etc/otelcol/config.yaml"]
