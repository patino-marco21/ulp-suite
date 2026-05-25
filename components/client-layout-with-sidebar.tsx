"use client";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import AppHeader from "@/components/app-header";

interface ClientLayoutWithSidebarProps {
  children: React.ReactNode;
  initialUserRole?: string | null;
}

export default function ClientLayoutWithSidebar({ children, initialUserRole }: ClientLayoutWithSidebarProps) {
  const pathname = usePathname();

  // Scroll to top on route change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [pathname]);

  // Determine page title based on pathname
  let title = "ULP Suite";
  if (pathname === "/dashboard") title = "ULP Suite - Dashboard";
  else if (pathname === "/") title = "ULP Suite - Search";
  else if (pathname === "/upload") title = "ULP Suite - Upload";
  else if (pathname === "/debug-zip") title = "ULP Suite - Debug ZIP";

  // Don't render sidebar/header for standalone pages (login, db-sync, public check portal)
  if (pathname === "/login" || pathname === "/db-sync" || pathname === "/check") {
    return (
      <main className="flex-1 bg-background">{children}</main>
    );
  }

  return (
    <>
      <AppSidebar initialUserRole={initialUserRole} />
      <div className="flex-1 flex flex-col min-w-0">
        <AppHeader title={title} />
        <main className="flex-1 bg-background">{children}</main>
      </div>
    </>
  );
} 