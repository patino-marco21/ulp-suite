"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Copy, BookOpen, Key, Search, Upload, Database, Shield, Clock, Zap, CheckCircle2, AlertCircle, ArrowRight, BarChart3, Monitor, ChevronLeft, ChevronRight } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import Link from "next/link"

export default function DocsPage() {
  const { toast } = useToast()
  const [activeSection, setActiveSection] = useState("search-credentials")
  const [baseUrl, setBaseUrl] = useState("")

  useEffect(() => {
    // Auto-detect domain from current URL
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin)
    }
  }, [])

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast({
      title: "Copied",
      description: "Code copied to clipboard"
    })
  }

  // Syntax highlighted code block component
  const CodeBlock = ({ code, language = "bash" }: { code: string; language?: string }) => {
    const highlightCode = (code: string, lang: string) => {
      if (lang === "json") {
        return code
          .replace(/"([^"]+)":/g, '<span class="text-purple-400">"$1"</span>:')
          .replace(/: "([^"]*)"/g, ': <span class="text-emerald-400">"$1"</span>')
          .replace(/: (\d+)/g, ': <span class="text-amber-400">$1</span>')
          .replace(/: (true|false|null)/g, ': <span class="text-blue-400">$1</span>')
          .replace(/\/\/.*$/gm, '<span class="text-muted-foreground">$&</span>')
      }
      if (lang === "bash") {
        return code
          .replace(/^(curl)/gm, '<span class="text-emerald-400">$1</span>')
          .replace(/(-X\s+)(GET|POST|PUT|DELETE|PATCH)/g, '$1<span class="text-amber-400">$2</span>')
          .replace(/(-H\s+)("[^"]*")/g, '$1<span class="text-blue-400">$2</span>')
          .replace(/(-d\s+)('[^']*')/g, '$1<span class="text-purple-400">$2</span>')
          .replace(/(-F\s+)("[^"]*")/g, '$1<span class="text-purple-400">$2</span>')
          .replace(/(https?:\/\/[^\s"'\\]+)/g, '<span class="text-cyan-400">$1</span>')
      }
      return code
    }

    return (
      <div className="relative group">
        <pre className="bg-zinc-950 border border-border/50 p-4 rounded-lg text-sm overflow-x-auto font-mono">
          <code 
            className={`language-${language}`}
            dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }}
          />
        </pre>
        <Button
          size="icon"
          variant="ghost"
          className="absolute top-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
          onClick={() => copyToClipboard(code)}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  // Parameter table component
  const ParameterTable = ({ params }: { params: Array<{ name: string; type: string; required: boolean; description: string; default?: string }> }) => (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-border/50 bg-muted/20 hover:bg-muted/20">
            <TableHead className="text-muted-foreground font-semibold">Parameter</TableHead>
            <TableHead className="text-muted-foreground font-semibold">Type</TableHead>
            <TableHead className="text-muted-foreground font-semibold">Required</TableHead>
            <TableHead className="text-muted-foreground font-semibold">Description</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {params.map((param) => (
            <TableRow key={param.name} className="border-border/50">
              <TableCell>
                <code className="text-sm font-mono text-foreground bg-muted/30 px-1.5 py-0.5 rounded">{param.name}</code>
              </TableCell>
              <TableCell>
                <span className="text-sm text-blue-400">{param.type}</span>
              </TableCell>
              <TableCell>
                {param.required ? (
                  <Badge className="bg-red-500/10 text-red-400 border-red-500/30 text-xs">Required</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground text-xs">Optional</Badge>
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {param.description}
                {param.default && (
                  <span className="block text-xs mt-1">Default: <code className="bg-muted/30 px-1 rounded">{param.default}</code></span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )

  const sections = [
    { id: "search-credentials", label: "Search Credentials", icon: Search, method: "POST" },
    { id: "search-domain", label: "Search Domain", icon: Search, method: "POST" },
    { id: "lookup", label: "Lookup", icon: Database, method: "GET" },
    { id: "batch-lookup", label: "Batch Lookup", icon: Database, method: "POST" },
    { id: "summary", label: "Summary", icon: BarChart3, method: "GET" },
    { id: "upload", label: "Upload", icon: Upload, method: "POST" },
    { id: "api-keys", label: "API Keys", icon: Key, method: "CRUD" },
    { id: "check-portal", label: "Check Portal", icon: Shield, method: "GET" },
  ]

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const checkScrollability = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    checkScrollability()
    const el = scrollContainerRef.current
    if (!el) return
    el.addEventListener("scroll", checkScrollability)
    const resizeObserver = new ResizeObserver(checkScrollability)
    resizeObserver.observe(el)
    return () => {
      el.removeEventListener("scroll", checkScrollability)
      resizeObserver.disconnect()
    }
  }, [checkScrollability])

  const scroll = (direction: "left" | "right") => {
    const el = scrollContainerRef.current
    if (!el) return
    el.scrollBy({ left: direction === "left" ? -200 : 200, behavior: "smooth" })
  }

  return (
    <main className="flex-1 p-6 bg-background">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <BookOpen className="h-7 w-7 text-primary" />
              </div>
              API Documentation
            </h1>
            <p className="text-muted-foreground mt-2">
              Complete reference for the BronVault REST API v1
            </p>
          </div>
          <Link href="/api-keys">
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Key className="mr-2 h-4 w-4" />
              Manage API Keys
            </Button>
          </Link>
        </div>

        {/* Base Info Cards */}
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <Card className="glass-card border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10">
                  <Shield className="h-5 w-5 text-emerald-500" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Authentication</p>
                  <code className="text-sm font-mono text-foreground">X-API-Key</code>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-card border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <Database className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Format</p>
                  <p className="text-sm font-medium text-foreground">JSON</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-card border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <Zap className="h-5 w-5 text-purple-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Base URL</p>
                  <code className="text-sm font-mono text-foreground">/api/v1</code>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-card border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <Clock className="h-5 w-5 text-amber-400" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Rate Limit</p>
                  <p className="text-sm font-medium text-foreground">Per API Key</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Navigation */}
        <Card className="glass-card border-border/50">
          <CardContent className="p-3">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 shrink-0 transition-opacity ${canScrollLeft ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                onClick={() => scroll("left")}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div
                ref={scrollContainerRef}
                className="flex gap-2 overflow-x-auto scrollbar-hide"
                style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
              >
              {sections.map((section) => {
                const isActive = activeSection === section.id
                return (
                  <Button 
                    key={section.id}
                    variant={isActive ? "default" : "outline"} 
                    size="sm"
                    onClick={() => setActiveSection(section.id)}
                    className={`shrink-0 ${isActive ? "bg-primary text-primary-foreground" : "glass-card border-border/50"}`}
                  >
                    <section.icon className="h-4 w-4 mr-2" />
                    {section.label}
                    <Badge 
                      variant="outline" 
                      className={`ml-2 text-xs ${
                        isActive 
                          ? "bg-white/20 text-white border-white/30"
                          : section.method === "GET" 
                            ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30" 
                            : section.method === "POST" 
                              ? "bg-blue-500/10 text-blue-400 border-blue-500/30" 
                              : "bg-purple-500/10 text-purple-400 border-purple-500/30"
                      }`}
                    >
                      {section.method}
                    </Badge>
                  </Button>
                )
              })}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 shrink-0 transition-opacity ${canScrollRight ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                onClick={() => scroll("right")}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Search Credentials Section */}
        {activeSection === "search-credentials" && (
          <div className="space-y-6">
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 font-mono">POST</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/search/credentials</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Search credentials by email, username, or password. Returns paginated results with device information.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    Request Body Parameters
                  </h4>
                  <ParameterTable params={[
                    { name: "query", type: "string", required: true, description: "The search query (email, username, or password)" },
                    { name: "type", type: "string", required: false, description: "Search type: email, username, password, or any", default: "any" },
                    { name: "page", type: "number", required: false, description: "Page number for pagination", default: "1" },
                    { name: "limit", type: "number", required: false, description: "Number of results per page (max 100)", default: "50" },
                    { name: "includePasswords", type: "boolean", required: false, description: "Include full passwords in response (admin only)", default: "false" },
                  ]} />
                </div>

                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X POST "${baseUrl}/api/v1/search/credentials" \\
  -H "X-API-Key: bv_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "john@example.com", "type": "email", "page": 1, "limit": 50}'`} />
                </div>

                {/* Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock 
                    language="json"
                    code={`{
  "success": true,
  "data": {
    "credentials": [
      {
        "deviceId": "device_123",
        "deviceName": "WIN-ABC123",
        "url": "https://example.com/login",
        "domain": "example.com",
        "username": "john@example.com",
        "passwordMasked": "p********d",
        "browser": "Chrome",
        "country": "US",
        "uploadDate": "2024-01-15T10:30:00Z",
        "hostInfo": {
          "os": "Windows 10 Pro",
          "ipAddress": "203.0.113.45",
          "machineUsername": "john",
          "cpu": "Intel Core i7-10700",
          "ram": "16 GB",
          "gpu": "NVIDIA GeForce RTX 3060",
          "hwid": "ABCD-1234-EFGH-5678",
          "antivirus": "Windows Defender",
          "stealerType": "RedLine",
          "logDate": "2024-01-15"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 150,
      "totalPages": 3,
      "hasMore": true
    }
  },
  "meta": {
    "query": "john@example.com",
    "type": "email",
    "searchedAt": "2024-01-15T10:30:00Z"
  }
}`}
                  />
                </div>

                {/* Error Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-red-400" />
                    Error Response
                    <Badge variant="outline" className="text-xs">4xx/5xx</Badge>
                  </h4>
                  <CodeBlock 
                    language="json"
                    code={`{
  "success": false,
  "error": "Invalid or missing API key",
  "code": "INVALID_API_KEY"
}`}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Search Domain Section */}
        {activeSection === "search-domain" && (
          <div className="space-y-6">
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 font-mono">POST</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/search/domain</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Search all credentials for a specific domain. Optionally includes subdomains.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Request Body Parameters</h4>
                  <ParameterTable params={[
                    { name: "domain", type: "string", required: true, description: "The domain to search for (e.g., example.com)" },
                    { name: "includeSubdomains", type: "boolean", required: false, description: "Include subdomains in search results", default: "false" },
                    { name: "page", type: "number", required: false, description: "Page number for pagination", default: "1" },
                    { name: "limit", type: "number", required: false, description: "Number of results per page (max 100)", default: "50" },
                  ]} />
                </div>

                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X POST "${baseUrl}/api/v1/search/domain" \\
  -H "X-API-Key: bv_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"domain": "example.com", "includeSubdomains": true, "page": 1, "limit": 50}'`} />
                </div>

                {/* Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock 
                    language="json"
                    code={`{
  "success": true,
  "data": {
    "domain": "example.com",
    "credentials": [
      {
        "deviceId": "device_456",
        "deviceName": "DESKTOP-XYZ",
        "url": "https://login.example.com",
        "subdomain": "login.example.com",
        "username": "admin@example.com",
        "passwordMasked": "a********n",
        "browser": "Firefox",
        "country": "DE",
        "uploadDate": "2024-01-15T10:30:00Z",
        "hostInfo": {
          "os": "Windows 11",
          "ipAddress": "198.51.100.22",
          "machineUsername": "admin",
          "cpu": "AMD Ryzen 9 5900X",
          "ram": "32 GB",
          "gpu": "AMD Radeon RX 6800",
          "hwid": "WXYZ-9876-ABCD-5432",
          "antivirus": "Norton",
          "stealerType": "Lumma",
          "logDate": "2024-01-14"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 75,
      "totalPages": 2,
      "hasMore": true
    },
    "summary": {
      "totalCredentials": 75,
      "uniqueDevices": 12,
      "subdomains": [
        { "domain": "login.example.com", "count": 45 },
        { "domain": "mail.example.com", "count": 30 }
      ]
    }
  },
  "meta": {
    "searchedDomain": "example.com",
    "includeSubdomains": true,
    "searchedAt": "2024-01-15T10:30:00Z"
  }
}`}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Lookup Section */}
        {activeSection === "lookup" && (
          <div className="space-y-6">
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 font-mono">GET</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/lookup</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Quick lookup to check if an email or domain exists. Returns summary statistics without full credential data.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Query Parameters</h4>
                  <ParameterTable params={[
                    { name: "email", type: "string", required: false, description: "Email address to lookup (use this OR domain)" },
                    { name: "domain", type: "string", required: false, description: "Domain to lookup (use this OR email)" },
                  ]} />
                  <p className="text-sm text-amber-500 mt-3 flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    Either <code className="bg-muted/50 px-1 rounded">email</code> or <code className="bg-muted/50 px-1 rounded">domain</code> must be provided, but not both.
                  </p>
                </div>

                {/* Example Request - Email */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request (Email Lookup)</h4>
                  <CodeBlock code={`curl "${baseUrl}/api/v1/lookup?email=john@example.com" \\
  -H "X-API-Key: bv_your_api_key"`} />
                </div>

                {/* Example Request - Domain */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request (Domain Lookup)</h4>
                  <CodeBlock code={`curl "${baseUrl}/api/v1/lookup?domain=example.com" \\
  -H "X-API-Key: bv_your_api_key"`} />
                </div>

                {/* Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock 
                    language="json"
                    code={`{
  "success": true,
  "data": {
    "type": "email",
    "query": "john@example.com",
    "found": true,
    "summary": {
      "totalCredentials": 15,
      "uniqueDevices": 3,
      "firstSeen": "2024-01-01T00:00:00Z",
      "lastSeen": "2024-12-01T00:00:00Z",
      "topDomains": [
        {"domain": "example.com", "count": 10},
        {"domain": "test.com", "count": 5}
      ],
      "countries": [
        {"country": "US", "count": 8},
        {"country": "UK", "count": 7}
      ]
    }
  },
  "meta": {
    "checkedAt": "2024-01-22T10:30:00Z"
  }
}`}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Summary Section */}
        {activeSection === "summary" && (
          <div className="space-y-6">
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 font-mono">GET</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/summary</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Returns dashboard summary data including overall statistics, top 50 TLDs, and country statistics with heatmap data. Useful for integrations and reporting.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Query Parameters</h4>
                  <ParameterTable params={[
                    { name: "startDate", type: "string", required: false, description: "Start date filter (YYYY-MM-DD format)", default: "All time" },
                    { name: "endDate", type: "string", required: false, description: "End date filter (YYYY-MM-DD format)", default: "All time" },
                  ]} />
                </div>

                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl "${baseUrl}/api/v1/summary" \\
  -H "X-API-Key: bv_your_api_key"`} />
                </div>

                {/* Example with date filter */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request (with Date Filter)</h4>
                  <CodeBlock code={`curl "${baseUrl}/api/v1/summary?startDate=2024-01-01&endDate=2024-12-31" \\
  -H "X-API-Key: bv_your_api_key"`} />
                </div>

                {/* Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock
                    language="json"
                    code={`{
  "success": true,
  "stats": {
    "credentials": 48200000,
    "unique_domains": 182000,
    "unique_emails": 15400000,
    "sources": 127
  },
  "top_domains": [
    { "domain": "gmail.com",   "count": 9200000 },
    { "domain": "yahoo.com",   "count": 3100000 },
    { "domain": "hotmail.com", "count": 2800000 }
    // ... up to 20 domains
  ]
}`}
                  />
                </div>

                {/* Data Included */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Data Included</h4>
                  <div className="grid gap-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      Total credential count, unique domains, unique emails, and source file count
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      Top 20 domains by credential volume
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Batch Lookup Section */}
        {activeSection === "batch-lookup" && (
          <div className="space-y-6">
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 font-mono">POST</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/lookup/batch</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Submit up to 100 email and/or domain queries in a single API call. Returns a results map keyed by query string. Each email lookup uses the bloom-filter skip index for fast exact matching.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Body Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">JSON Body</h4>
                  <ParameterTable params={[
                    { name: "emails", type: "string[]", required: false, description: "Array of email addresses to look up (exact match). Max 100 total queries." },
                    { name: "domains", type: "string[]", required: false, description: "Array of domains to look up (exact match). Max 100 total queries." },
                  ]} />
                </div>

                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X POST "${baseUrl}/api/v1/lookup/batch" \\
  -H "X-API-Key: bv_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"emails":["alice@example.com","bob@test.org"],"domains":["github.com"]}'`} />
                </div>

                {/* Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock
                    language="json"
                    code={`{
  "success": true,
  "queried": 3,
  "found": 2,
  "results": {
    "alice@example.com": {
      "found": true,
      "count": 3,
      "results": [
        {
          "email": "alice@example.com",
          "url": "https://example.com/login",
          "domain": "example.com",
          "source_file": "dump_2024.txt",
          "breach_name": "Example2024",
          "imported_at": "2024-03-15 09:22:00"
        }
        // ... up to 50 results per query
      ]
    },
    "bob@test.org": { "found": false, "count": 0, "results": [] },
    "github.com": {
      "found": true,
      "count": 50,
      "results": [ /* ... */ ]
    }
  }
}`}
                  />
                </div>

                {/* Notes */}
                <div className="grid gap-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Maximum 100 total queries per request (emails + domains combined)
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Results capped at 50 rows per individual query
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Email addresses are lowercased automatically before matching
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Upload Section */}
        {activeSection === "upload" && (
          <div className="space-y-6">
            {/* Admin Warning */}
            <Card className="glass-card border-amber-500/20">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-amber-500/10">
                    <Shield className="h-5 w-5 text-amber-500" />
                  </div>
                  <p className="text-sm text-amber-500">
                    <strong>Admin Role Required:</strong> Only API keys with admin role can access upload endpoints.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 font-mono">POST</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/upload</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Upload a credential file (.txt, .csv, or .zip). The file is processed synchronously and returns import statistics when complete. Admin API key required.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Form Data Parameters</h4>
                  <ParameterTable params={[
                    { name: "file", type: "file", required: true, description: "Credential file in .txt, .csv, or .zip format. ZIP archives may contain multiple .txt/.csv files." },
                  ]} />
                </div>

                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X POST "${baseUrl}/api/v1/upload" \\
  -H "X-API-Key: bv_admin_api_key" \\
  -F "file=@stealer_logs.zip"`} />
                </div>

                {/* Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock
                    language="json"
                    code={`{
  "success": true,
  "filename": "credentials.txt",
  "imported": 45230,
  "skipped": 4770,
  "errors": 0,
  "import_pct": 90.5,
  "breach_name": "AutoDetected2024",
  "rejection_breakdown": {
    "blank": 1200,
    "no_login": 890,
    "pass_too_short": 680,
    "dedup": 540,
    "no_fields": 1460
  }
}`}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Upload form data note */}
            <Card className="glass-card border-border/50">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-blue-500/10 shrink-0">
                    <Zap className="h-4 w-4 text-blue-400" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">Supported file formats</p>
                    <p className="text-sm text-muted-foreground">
                      The upload endpoint accepts <code className="text-xs bg-muted px-1 rounded">.txt</code>,{" "}
                      <code className="text-xs bg-muted px-1 rounded">.csv</code>, and{" "}
                      <code className="text-xs bg-muted px-1 rounded">.zip</code> archives containing multiple credential files.
                      Breach tagging, duplicate detection, and domain extraction happen automatically at ingest time.
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      To preview how a file will parse without storing anything, use the{" "}
                      <code className="text-xs bg-muted px-1 rounded">POST /api/admin/parse-sample</code> diagnostic endpoint
                      (admin only, plain-text body, max 10,000 lines).
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* API Keys Section */}
        {activeSection === "api-keys" && (
          <div className="space-y-6">
            {/* List API Keys */}
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 font-mono">GET</Badge>
                    <code className="text-lg font-mono text-foreground">/api/v1/api-keys</code>
                  </div>
                  <Link href="/api-keys">
                    <Button variant="outline" size="sm" className="glass-card border-border/50">
                      <ArrowRight className="h-4 w-4 mr-2" />
                      Manage Keys
                    </Button>
                  </Link>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  List all API keys. Analysts see only their own keys, admins see all keys.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl "${baseUrl}/api/v1/api-keys" \\
  -H "X-API-Key: bv_your_api_key"`} />
                </div>

                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock 
                    language="json"
                    code={`{
  "success": true,
  "data": {
    "apiKeys": [
      {
        "id": 1,
        "name": "My Integration",
        "keyPrefix": "bv_abc123",
        "role": "analyst",
        "rateLimit": 100,
        "rateLimitWindow": 60,
        "isActive": true,
        "expiresAt": null,
        "lastUsedAt": "2024-01-20T15:30:00Z",
        "createdAt": "2024-01-01T10:00:00Z"
      }
    ]
  }
}`}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Create API Key */}
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 font-mono">POST</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/api-keys</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Create a new API key. The full key is only returned once.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Request Body Parameters</h4>
                  <ParameterTable params={[
                    { name: "name", type: "string", required: true, description: "A descriptive name for the API key" },
                    { name: "role", type: "string", required: false, description: "Key role: analyst or admin", default: "analyst" },
                    { name: "rateLimit", type: "number", required: false, description: "Max requests per window", default: "100" },
                    { name: "rateLimitWindow", type: "number", required: false, description: "Time window in seconds", default: "60" },
                  ]} />
                </div>

                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X POST "${baseUrl}/api/v1/api-keys" \\
  -H "X-API-Key: bv_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My Integration", "role": "analyst", "rateLimit": 100, "rateLimitWindow": 60}'`} />
                </div>

                {/* Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">201 Created</Badge>
                  </h4>
                  <CodeBlock 
                    language="json"
                    code={`{
  "success": true,
  "message": "API key created successfully. Save this key - it will not be shown again!",
  "data": {
    "apiKey": "bv_newkeyhere123456789012345678",
    "keyInfo": {
      "id": 123,
      "name": "My Integration",
      "keyPrefix": "bv_newkey",
      "role": "analyst",
      "rateLimit": 100,
      "rateLimitWindow": 60
    }
  }
}`}
                  />
                  <div className="mt-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
                    <p className="text-sm text-amber-500 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      The full API key is only shown once. Store it securely.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Delete API Key */}
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-red-500/10 text-red-400 border-red-500/30 font-mono">DELETE</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/api-keys/:id</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Delete an API key. This action cannot be undone.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Path Parameters</h4>
                  <ParameterTable params={[
                    { name: "id", type: "number", required: true, description: "The ID of the API key to delete" },
                  ]} />
                </div>

                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X DELETE "${baseUrl}/api/v1/api-keys/123" \\
  -H "X-API-Key: bv_your_api_key"`} />
                </div>

                {/* Response */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Success Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock 
                    language="json"
                    code={`{
  "success": true,
  "message": "API key deleted successfully"
}`}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Toggle API Key Status */}
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-orange-500/10 text-orange-400 border-orange-500/30 font-mono">PATCH</Badge>
                  <code className="text-lg font-mono text-foreground">/api/v1/api-keys/:id</code>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Update API key status (activate/deactivate).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Parameters */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Path Parameters</h4>
                  <ParameterTable params={[
                    { name: "id", type: "number", required: true, description: "The ID of the API key to update" },
                  ]} />
                </div>

                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Request Body Parameters</h4>
                  <ParameterTable params={[
                    { name: "isActive", type: "boolean", required: true, description: "Set to true to activate, false to deactivate" },
                  ]} />
                </div>

                {/* Example Request */}
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl -X PATCH "${baseUrl}/api/v1/api-keys/123" \\
  -H "X-API-Key: bv_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"isActive": false}'`} />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Check Portal ── */}
        {activeSection === "check-portal" && (
          <div className="space-y-6" id="check-portal">
            <Card className="glass-card border-border/50">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 font-mono">GET</Badge>
                  <code className="text-lg font-mono text-foreground">/api/check</code>
                  <Badge variant="outline" className="text-xs text-green-500 border-green-500/40">No API key required</Badge>
                </div>
                <CardDescription className="text-muted-foreground mt-2">
                  Self-service email breach check. Returns breach names only — <strong>passwords are never exposed</strong>.
                  Designed for end-user self-lookup (HIBP-style). Rate-limited per IP and per email address.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Query Parameters</h4>
                  <ParameterTable params={[
                    { name: "email", type: "string", required: true, description: "The email address to check. Must be a valid email containing @." },
                  ]} />
                </div>

                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 space-y-1">
                  <p className="text-sm font-medium text-amber-400 flex items-center gap-2">
                    <Clock className="h-4 w-4" />Rate Limits
                  </p>
                  <ul className="text-sm text-muted-foreground space-y-1 ml-6 list-disc">
                    <li>10 requests per IP per minute</li>
                    <li>50 lookups per email address per hour (prevents enumeration of a specific target)</li>
                    <li>Returns <code className="bg-muted/30 px-1 rounded">429</code> with <code className="bg-muted/30 px-1 rounded">Retry-After</code> header when exceeded</li>
                  </ul>
                </div>

                <div>
                  <h4 className="font-semibold mb-3 text-foreground">Example Request</h4>
                  <CodeBlock code={`curl "${baseUrl}/api/check?email=alice%40example.com"`} />
                </div>

                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Found Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock language="json" code={`{
  "success": true,
  "email": "alice@example.com",
  "found": true,
  "breach_count": 2,
  "breaches": [
    {
      "name": "ExampleBreach2024",
      "domains": ["example.com", "shop.example.com"],
      "first_seen": "2024-03-15T00:00:00Z"
    },
    {
      "name": "ComboList2023",
      "domains": ["example.com"],
      "first_seen": "2023-11-01T00:00:00Z"
    }
  ]
}`} />
                </div>

                <div>
                  <h4 className="font-semibold mb-3 text-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Clean Response
                    <Badge variant="outline" className="text-xs">200 OK</Badge>
                  </h4>
                  <CodeBlock language="json" code={`{
  "success": true,
  "email": "clean@example.com",
  "found": false,
  "breach_count": 0,
  "breaches": []
}`} />
                </div>

                <div className="rounded-lg border border-border/50 bg-muted/10 p-4 space-y-2">
                  <p className="text-sm font-medium text-foreground">Security notes</p>
                  <ul className="text-sm text-muted-foreground space-y-1 ml-4 list-disc">
                    <li>Passwords are <strong>never</strong> returned by this endpoint — breach names and domains only</li>
                    <li>Responses carry <code className="bg-muted/30 px-1 rounded">Cache-Control: private, no-store</code></li>
                    <li>A browser-friendly UI is available at <Link href="/check" className="text-primary hover:underline">/check</Link></li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </main>
  )
}
