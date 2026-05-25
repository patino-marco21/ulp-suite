"use client"

import { Upload, Database, Settings, Users, LucideIcon, Key, BookOpen, ClipboardList, FileText, Radio, BarChart2, AlertTriangle, Layers, ShieldAlert, Search, Shield } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import { Sun, Moon } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import React from "react"
import { useAuth, isAdmin } from "@/hooks/useAuth"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
} from "@/components/ui/sidebar"

interface MenuItem {
  title: string
  url: string
  icon: LucideIcon
  adminOnly?: boolean
}

interface MenuGroup {
  title: string
  items: MenuItem[]
}

const menuGroups: MenuGroup[] = [
  {
    title: "Search",
    items: [
      { title: "Credentials", url: "/credentials", icon: Database },
      { title: "Batch Lookup",  url: "/lookup",      icon: Search },
      { title: "Reuse", url: "/reuse", icon: AlertTriangle },
      { title: "Similar", url: "/similar", icon: Layers },
      { title: "Breaches", url: "/breaches", icon: ShieldAlert },
      { title: "Stats", url: "/stats", icon: BarChart2 },
    ],
  },
  {
    title: "Import",
    items: [
      { title: "Upload", url: "/upload", icon: Upload, adminOnly: true },
      { title: "Sources", url: "/sources", icon: FileText },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { title: "Domains", url: "/monitoring", icon: Radio, adminOnly: true },
      { title: "Check Portal",  url: "/check",       icon: Shield },
    ],
  },
  {
    title: "System",
    items: [
      { title: "Users", url: "/users", icon: Users, adminOnly: true },
      { title: "API Keys", url: "/api-keys", icon: Key },
      { title: "API Docs", url: "/docs", icon: BookOpen },
      { title: "Audit Logs", url: "/audit-logs", icon: ClipboardList, adminOnly: true },
      { title: "Settings", url: "/settings", icon: Settings, adminOnly: true },
    ],
  },
]

interface AppSidebarProps {
  initialUserRole?: string | null
}

export function AppSidebar({ initialUserRole }: AppSidebarProps) {
  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const [logoSrc, setLogoSrc] = React.useState("/images/logo.png")

  const { user } = useAuth(false)
  const userIsAdmin = user ? isAdmin(user) : initialUserRole === 'admin'

  const isActive = (url: string) => {
    if (pathname === url) return true
    if (url === "/monitoring") return pathname.startsWith("/monitoring") || pathname === "/domains"
    if (url === "/breaches")   return pathname === "/breaches" || pathname.startsWith("/breaches/")
    if (url === "/check")      return pathname === "/check"  // public page, exact match only
    return pathname.startsWith(url + "/")
  }

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (mounted) {
      const ts = new Date().getTime()
      const logo = resolvedTheme === 'light' ? "/images/logo-light.png" : "/images/logo.png"
      setLogoSrc(`${logo}?t=${ts}`)
    }
  }, [mounted, resolvedTheme])

  const visibleGroups = menuGroups
    .map(g => ({ ...g, items: g.items.filter(item => !item.adminOnly || userIsAdmin) }))
    .filter(g => g.items.length > 0)

  return (
    <Sidebar className="border-r-[2px] border-border bg-sidebar/80 backdrop-blur-xl transition-all duration-300">
      <SidebarHeader className="border-b-[2px] border-border p-6 pb-8">
        <div className="flex flex-col items-center">
          <div className="relative mb-2">
            <img src={logoSrc} alt="ULP Suite" className="relative h-10 w-auto" />
          </div>
          <p className="text-[11px] tracking-widest text-muted-foreground leading-tight text-center font-medium mt-2">
            Credential search engine
          </p>
        </div>
      </SidebarHeader>

      <SidebarContent className="flex flex-col h-full px-2 py-4">
        <div className="flex-1 overflow-auto space-y-4">
          {visibleGroups.map(group => (
            <SidebarGroup key={group.title} className="bg-transparent p-0">
              <SidebarGroupLabel className="px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
                {group.title}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="space-y-1">
                  {group.items.map(item => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive(item.url)}
                        className={`
                          group relative w-full overflow-hidden rounded-xl px-4 py-1.5 transition-all duration-300 h-auto min-h-8
                          ${isActive(item.url)
                            ? "bg-primary/10 text-primary shadow-[0_0_20px_-5px_rgba(230,27,0,0.3)]"
                            : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                          }
                        `}
                      >
                        <Link href={item.url} className="flex items-center space-x-3 w-full relative z-10">
                          <item.icon className={`h-5 w-5 transition-transform duration-300 ${isActive(item.url) ? 'scale-110' : 'group-hover:scale-110'}`} />
                          <div className="flex-1 min-w-0">
                            <div className={`font-medium tracking-wide ${isActive(item.url) ? 'font-semibold' : ''}`}>
                              {item.title}
                            </div>
                          </div>
                          {isActive(item.url) && (
                            <div className="absolute right-0 h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_2px_rgba(230,27,0,0.5)] animate-pulse" />
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </div>

        <div className="mt-auto px-4 py-4 border-t-[2px] border-border">
          <div className="flex items-center justify-between rounded-xl bg-white/5 p-1 backdrop-blur-sm border border-white/5">
            <div className="flex items-center gap-2 px-2">
              <Sun className="h-3 w-3 text-amber-500" />
            </div>
            {mounted && (
              <Switch
                checked={resolvedTheme === 'dark'}
                onCheckedChange={checked => setTheme(checked ? 'dark' : 'light')}
                aria-label="Toggle theme"
                className="scale-75 data-[state=checked]:bg-primary bg-muted"
              />
            )}
            <div className="flex items-center gap-2 px-2">
              <Moon className="h-3 w-3 text-blue-500" />
            </div>
          </div>
        </div>
      </SidebarContent>
    </Sidebar>
  )
}
