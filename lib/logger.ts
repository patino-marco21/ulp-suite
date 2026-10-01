/** Error logging for client components (components/error-boundary.tsx). */
export const logError = (message: string, data?: any, context?: string) =>
  console.error(`${context ? `[${context}] ` : ''}${message}`, data)
