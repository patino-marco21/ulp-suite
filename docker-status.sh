#!/bin/bash

# =====================================================
# ULP Suite - Docker Status & URLs
# =====================================================
# Script to display service status and access URLs
# =====================================================

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}📊 ULP Suite Service Status${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check service status
docker compose ps

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}📍 Access URLs:${NC}"
echo ""
echo -e "  🌐 ${YELLOW}ULP Suite App:${NC}     http://localhost:3000"
echo -e "  🗄️  ${YELLOW}ClickHouse SQL:${NC}    docker exec -it ulpsuite_clickhouse clickhouse-client"
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
echo -e "${BLUE}💡 Useful Commands:${NC}"
echo ""
echo -e "  View logs:        ${YELLOW}docker compose logs -f${NC}"
echo -e "  Stop services:    ${YELLOW}docker compose down${NC}"
echo -e "  Restart services: ${YELLOW}docker compose restart${NC}"
echo -e "  Check status:     ${YELLOW}./docker-status.sh${NC}"
echo ""

