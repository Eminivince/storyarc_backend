export type AuthenticatedRequest = {
  auth?: {
    userId: string;
    sessionId: string;
    role: string;
  };
  headers: Record<string, string | string[] | undefined>;
  id?: string;
  ip?: string;
  url?: string;
  method?: string;
  raw?: {
    socket?: {
      remoteAddress?: string;
    };
  };
};
