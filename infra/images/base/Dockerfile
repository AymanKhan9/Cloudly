FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*


ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.com/install | bash -s "bun-v1.3.0"

RUN bun add -g @openai/codex

RUN mkdir -p /workspace && chown 1000:1000 /workspace

WORKDIR  /workspace

USER 1000