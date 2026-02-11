import "fastify";

export interface JwtClaims {
  iss: string;
  aud: string;
  sub: string;
  appId: string;
  teamId?: string;
  userId?: string;
  scopes: string[];
  iat: number;
  exp: number;
  jti: string;
  kid: string;
  reqHash?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    jwtClaims?: JwtClaims;
  }
}
