// Response helpers shared by the routes.

export const json = (body: unknown, status = 200) => Response.json(body, { status })

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
