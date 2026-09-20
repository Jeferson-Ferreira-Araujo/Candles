import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Sessao minima em memoria — de proposito. Este app e para uso de UMA pessoa; nao ha
 * cadastro de usuarios nem senha propria do app. "Logar" aqui significa "provar que voce
 * tem um SSID valido da Polarium agora" (ver BrokerManager.loginWithSsid). A sessao so
 * marca que esse processo ja aconteceu nesta aba/navegador, para nao pedir o SSID de novo
 * a cada requisicao.
 *
 * Reiniciar o servidor derruba todas as sessoes (por design: forca reautenticar o SSID,
 * que pode ter expirado de qualquer forma).
 */
const sessions = new Map<string, { createdAt: number }>();

export const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

export function createSession(): string {
  const token = randomUUID();
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

function isValid(token: string | undefined): boolean {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function isRequestAuthenticated(req: Request): boolean {
  return isValid(req.cookies?.[SESSION_COOKIE]);
}

/**
 * Middleware que exige sessao valida. Deve ser pulado inteiramente quando o app roda em
 * modo mock (nada de real em jogo) — quem monta as rotas decide isso, este middleware so
 * checa a sessao.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isRequestAuthenticated(req)) {
    res.status(401).json({ error: 'Nao autenticado. Faca login com um SSID valido.' });
    return;
  }
  next();
}
