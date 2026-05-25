#!/bin/bash

# =====================================================
# ULP Suite - Docker Start Script with Summary
# =====================================================
# Wrapper for: docker compose up -d --build
# =====================================================

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# --- Docker & Compose v2 detection ---

# Ensure Docker binary exists
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}⚠ Docker not detected.${NC}"
    echo ""

    if grep -qi ubuntu /etc/os-release 2>/dev/null; then
        echo -e "${BLUE}ℹ Ubuntu detected. Running install_docker.sh...${NC}"
        echo ""

        if [ -f "./install_docker.sh" ]; then
            chmod +x ./install_docker.sh
            ./install_docker.sh
        else
            echo -e "${RED}❌ install_docker.sh not found.${NC}"
            exit 1
        fi

        echo ""
        echo -e "${GREEN}✅ Docker installed.${NC}"
        echo -e "${YELLOW}⚠ Please logout and login again before running this script.${NC}"
        exit 0
    else
        echo -e "${RED}❌ Docker not found and auto-install only supported on Ubuntu.${NC}"
        exit 1
    fi
fi

# Ensure Docker Compose v2 exists
if ! docker compose version &> /dev/null; then
    echo -e "${YELLOW}⚠ Docker Compose v2 not detected.${NC}"
    echo ""
    echo "Please ensure docker-compose-plugin is installed."
    echo "On Ubuntu:"
    echo "  sudo apt install docker-compose-plugin"
    exit 1
fi

echo -e "${GREEN}✅ Docker Compose v2 detected.${NC}"
echo ""

# Check Docker daemon
if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Cannot connect to Docker daemon.${NC}"
    echo ""
    echo "If you just installed Docker, logout/login first."
    echo "Or try:"
    echo "  sudo systemctl start docker"
    echo ""
    exit 1
fi

echo -e "${GREEN}✅ Docker daemon is running.${NC}"
echo ""

# --- Ensure .env exists (required for JWT_SECRET and admin credentials) ---
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}⚠️  No .env file found. Generating one from .env.example...${NC}"
    if [ -f ".env.example" ]; then
        cp .env.example .env
        # Replace the placeholder JWT_SECRET with a real random value
        RANDOM_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64 | head -c 64)
        sed -i "s/change-me-to-a-random-32-char-string/${RANDOM_SECRET}/" .env
        echo -e "${GREEN}✅ .env created with a random JWT_SECRET.${NC}"
        echo -e "${BLUE}ℹ️  Review .env before production use — especially ADMIN_PASSWORD.${NC}"
    else
        echo -e "${RED}❌ .env.example not found. Cannot auto-generate .env.${NC}"
        echo "    Please create a .env file manually. See README.md for required variables."
        exit 1
    fi
    echo ""
fi

# --- Start services ---

echo -e "${CYAN}🚀 Starting ULP Suite Services...${NC}"
echo ""

# Ensure uploads directory exists (container entrypoint will fix ownership at startup)
# Best practice: run without sudo; no host UID/GID matching needed
echo -e "${BLUE}ℹ️  Ensuring uploads and data directories exist...${NC}"
mkdir -p ./uploads/chunks
mkdir -p ./uploads/extracted_files
# data/ holds the SQLite database; create it here so Docker does not create it
# as root (which would cause permission errors when the app tries to write the DB).
mkdir -p ./data
echo -e "${GREEN}✅ Uploads and data directories ready${NC}"
echo ""

echo -e "${BLUE}ℹ️  Building and starting services (using cache for unchanged layers)...${NC}"
docker compose up -d --build

echo ""
echo -e "${GREEN}✅ All services started!${NC}"
echo ""

# Wait a bit to ensure all services are ready
sleep 3

# Display status and URLs using separate script
echo ""
if [ -f "./docker-status.sh" ]; then
    ./docker-status.sh
else
    # Fallback if docker-status.sh doesn't exist
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}📊 ULP Suite Service Status${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    docker compose ps
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}📍 Access URLs:${NC}"
    echo ""
    echo -e "  🌐 ${YELLOW}ULP Suite App:${NC}     http://localhost:3000"
    echo -e "  📊 ${YELLOW}ClickHouse Play:${NC}    http://localhost:8123/play"
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}🔐 Default Login Credentials:${NC}"
    echo ""
    echo -e "  ${YELLOW}Email:${NC}    admin@ulpsuite.local"
    echo -e "  ${YELLOW}Password:${NC} admin"
    echo ""
    echo -e "  ${BLUE}ℹ️  Please change the password after first login for security.${NC}"
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
fi

