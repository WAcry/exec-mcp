import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ProxyFixtures } from "./proxy-fixtures.js";

let fixtures: ProxyFixtures;
beforeEach(() => {
  fixtures = new ProxyFixtures();
});
afterEach(() => fixtures.close());

describe("OAuth key discovery uses the real TLS and proxy transport", () => {
  it("verifies an issued access token through an environment-proxied JWKS without forwarding bearer credentials", async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: "fixture-key",
      alg: "RS256",
      use: "sig",
    };
    let requests = 0;
    const identity = await fixtures.server((request, response) => {
      requests++;
      expect(request.url).toBe("/jwks");
      expect(request.headers.authorization).toBeUndefined();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
    }, true);
    const proxy = await fixtures.proxy((authority) => {
      expect(authority).toBe("files.example.test:443");
      return identity.port;
    });
    const jwt = await new SignJWT({ sub: "owner", scope: "exec" })
      .setIssuer("https://identity.example.test/")
      .setAudience("https://exec.example.test/mcp")
      .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    const result = await fixtures.child(
      `
      import {startServer} from './src/server.ts';
      import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
      const server=await startServer({access:'public',public_url:'https://exec.example.test',host:'127.0.0.1',port:0,mcpServers:[],auth:{type:'oauth',issuer:'https://identity.example.test/',jwks_url:'https://files.example.test/jwks',subject:'owner',scopes:['exec']}});
      const client=new Client({name:'oauth-test',version:'1'});
      try{
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:{Authorization:'Bearer '+${JSON.stringify(jwt)}}}}));
        const result=await client.callTool({name:'exec',arguments:{source:'text(42);'}});
        console.log(JSON.stringify({success:!result.isError&&result.content.some(x=>x.type==='text'&&x.text==='42')}));
      }finally{await client.close();await server.close();}
    `,
      { HTTPS_PROXY: proxy.url },
    );
    expect(JSON.parse(result.stdout)).toEqual({ success: true });
    expect(requests).toBe(1);
    expect(proxy.calls).toHaveLength(1);
    expect(result.stdout).not.toContain(jwt);
  });
});
