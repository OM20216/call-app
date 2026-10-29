import { useState, useEffect, useCallback } from 'react'

export default function useAuth() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      const data = await res.json()
      if (data.authenticated) setUser(data.user)
      else setUser(null)
    } catch (e) {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { check() }, [check])

  return { user, loading, check }
}
