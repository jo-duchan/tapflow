import { ErrorPage } from '@/components/ErrorPage'

export function NotFound() {
  return <ErrorPage code={404} message="page not found" />
}
