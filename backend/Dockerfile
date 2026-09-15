FROM rust:1.98-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/world-drawer-backend /usr/local/bin/world-drawer-backend
EXPOSE 5787
CMD ["world-drawer-backend"]
