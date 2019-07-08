const { listen, stat, open, readAll } = Deno;
import { Server, ServerRequest } from 'http://deno.land/std/http/server.ts';
import { Response, processResponse } from './response.ts';
import { ErrorCode, getErrorMessage } from './errors.ts';
import { Method, Handler, HandlerConfig } from './handler.ts';
import { Params, parseURLSearchParams } from './params.ts';
import { defaultPort } from './constants.ts';
import { detectedContentType } from './mime.ts';
export { contentType, detectedContentType } from './mime.ts';
export {
  get,
  post,
  put,
  patch,
  del,
  options,
  link,
  unlink,
} from './handler.ts';
export { Response } from './response.ts';

type HandlerMap = Map<string, Map<string, Handler>>; // Map<method, Map<path, handler>>

export function app(...handlerConfigs: HandlerConfig[]): App {
  const a = new App(defaultPort);
  a.handle(...handlerConfigs);
  a.serve();
  return a;
}

export class App {
  private handlerMap: HandlerMap = new Map();
  private server: Server;

  constructor(
    public readonly port = defaultPort,
    public readonly staticEnabled = true,
    public readonly publicDir = 'public'
  ) {
    for (const method in Method) {
      this.handlerMap.set(method, new Map());
    }
  }

  // respondStatic returns Response with static file gotten from a path. If a given path didn't match, this method returns null.
  private async respondStatic(path: string): Promise<Response> {
    let fileInfo: Deno.FileInfo;
    let staticFilePath = `${this.publicDir}${path}`;
    try {
      fileInfo = await stat(staticFilePath);
    } catch (e) {
      // Do nothing here.
    }
    if (fileInfo && fileInfo.isDirectory()) {
      staticFilePath += '/index.html';
      try {
        fileInfo = await stat(staticFilePath);
      } catch (e) {
        fileInfo = null; // FileInfo is not needed any more.
      }
    }
    if (!fileInfo || !fileInfo.isFile()) {
      return null;
    }
    return [
      200,
      {
        'Content-Length': fileInfo.len.toString(),
        ...detectedContentType(staticFilePath),
      },
      await open(staticFilePath),
    ];
  }

  // respond returns Response with from informations of Request.
  private async respond(
    path,
    search: string,
    method: Method,
    req: ServerRequest
  ): Promise<Response> {
    const map = this.handlerMap.get(method);
    if (!map) {
      return null;
    }

    const handler = map.get(path);
    if (!handler) {
      return null;
    }

    const params: Params = {};
    if (method === Method.GET) {
      if (search) {
        Object.assign(params, parseURLSearchParams(search));
      }
    } else {
      const rawContentType =
        req.headers.get('content-type') || 'application/octet-stream';
      const [contentType, ...typeParamsArray] = rawContentType
        .split(';')
        .map(s => s.trim());
      const typeParams = typeParamsArray.reduce((params, curr) => {
        const [key, value] = curr.split('=');
        params[key] = value;
        return params;
      }, {});

      const decoder = new TextDecoder(typeParams['charset'] || 'utf-8'); // TODO: downcase `charset` key
      const decodedBody = decoder.decode(await req.body());

      switch (contentType) {
        case 'application/x-www-form-urlencoded':
          Object.assign(params, parseURLSearchParams(decodedBody));
          break;
        case 'application/json':
          let obj: Object;
          try {
            obj = JSON.parse(decodedBody);
          } catch (e) {
            throw ErrorCode.BadRequest;
          }
          Object.assign(params, obj);
          break;
        case 'application/octet-stream':
          // FIXME: we skip here for now, it should be implemented when Issue #41 resolved.
          break;
      }
    }

    const ctx = { path, method, params };
    const res = handler(ctx);
    if (res instanceof Promise) {
      return await (res as Promise<Response>);
    }
    return res;
  }

  public handle(...handlerConfigs: HandlerConfig[]) {
    for (const { path, method, handler } of handlerConfigs) {
      this.handlerMap.get(method).set(path, handler);
    }
  }

  public async serve() {
    const addr = `0.0.0.0:${this.port}`;
    const listener = listen('tcp', addr);
    console.log(`listening on http://${addr}/`);
    this.server = new Server(listener);
    for await (const req of this.server) {
      const method = req.method as Method;
      let r: Response;
      if (!req.url) {
        throw ErrorCode.NotFound;
      }
      const [path, search] = req.url.split(/\?(.+)/);
      try {
        r =
          (await this.respond(path, search, method, req)) ||
          (this.staticEnabled && (await this.respondStatic(path)));
        if (!r) {
          throw ErrorCode.NotFound;
        }
      } catch (err) {
        let status = ErrorCode.InternalServerError;
        if (typeof err === 'number') {
          status = err;
        } else {
          console.error(err);
        }
        r = [status, getErrorMessage(status)];
      }
      await req.respond(processResponse(r));
    }
  }

  public close() {
    this.server.close();
  }
}
