import { redirect } from "next/navigation"

// Alias for the domain monitoring page.
// Monitoring config (monitors, webhooks) lives at /monitoring.
export default function DomainsPage() {
  redirect("/monitoring")
}
