import { performance } from 'perf_hooks';
import * as Redis from 'ioredis';
import { isEmpty, isObjectLike } from 'lodash';
import hyperid = require('hyperid');
import Reference, { ReferenceType } from './Reference';

export default class Rejects {
  public generateID: () => string;

  constructor(public readonly client: Redis.Redis) {
    this.generateID = hyperid();
  }

  public async delete(key: string): Promise<number> {
    const data = await this.client.hgetall(key);
    const promises: Promise<number>[] = [];

    for (const ref of Object.values(data) as string[]) {
      if (Reference.is(ref)) {
        const { key: newKey } = new Reference(ref).decode();
        promises.push(this.delete(newKey));
      }
    }

    if (promises.length) await Promise.all(promises);
    return this.client.del(key);
  }

  public upsert(key: string, obj: object): PromiseLike<Array<0 | 1>> {
    if (key.includes('.')) {
      const route = key.split('.');
      let newKey: string | undefined;
      while (newKey = route.pop()) {
        if (route.length) {
          obj = { [newKey]: obj };
        } else {
          key = newKey;
          break;
        }
      }
    }

    console.log(performance.now());
    const p = this._upsert(key, obj);
    console.log(performance.now());
    return p.exec().then(r => {
      console.log(performance.now())
      return r;
    });
  }

  protected _upsert(
    rootKey: string,
    obj: object,
    opts: {
      pipeline: Redis.Pipeline;
      seen: any[];
    } = {
      pipeline: this.client.pipeline(),
      seen: [],
    },
  ): Redis.Pipeline {
    if (isEmpty(obj)) return opts.pipeline;

    if (opts.seen.includes(obj)) throw new TypeError('cannot store circular structure in Redis');
    if (isObjectLike(obj)) opts.seen.push(obj);

    const toSet: string[] = [];
    const isArray = Array.isArray(obj);
    for (let [key, value] of Object.entries(obj)) {
      if (isArray) key = this.generateID();
      if (isObjectLike(value) && !(value instanceof Reference)) {
        const newKey = rootKey.concat('.', key);
        this._upsert(newKey, value, opts);
        value = new Reference(newKey, Array.isArray(value) ? ReferenceType.ARRAY : ReferenceType.OBJECT).toString()
      } else {
        value = `raw:${value}`;
      }

      toSet.push(key, value);
    }

    return opts.pipeline.hmset(rootKey, toSet);
  }

  public async set(key: string, obj: object): Promise<Array<0 | 1>> {
    await this.delete(key);
    return this.upsert(key, obj);
  }

  public async get<T = any>(key: string, opts?: { type?: ReferenceType, depth?: number }): Promise<T | null> {
    return this._get<T>(key, opts);
  }

  protected async _get<T>(
    rootKey: string,
    {
      type = ReferenceType.OBJECT,
      depth = -1,
      currentDepth = 0
    }: {
      type?: ReferenceType;
      depth?: number;
      currentDepth?: number;
    } = {}
  ): Promise<T | null> {
    const data = await this.client.hgetall(rootKey);
    if (!Object.keys(data).length) return null;

    if (depth < 0 || currentDepth < depth) {
      const nested: [string, Promise<T | null>][] = [];
      for (const [key, val] of Object.entries(data) as [string, string][]) {
        if (!Reference.is(val)) {
          for (const [k, v] of Object.entries(data) as [string, string][]) {
            if (v.startsWith('raw:')) data[k] = v.slice(4); // remove conditional in next major version
          }
        } else {
          const { type, key: newKey } = new Reference(val).decode();
          nested.push([key, this._get(newKey, { type, depth, currentDepth: currentDepth + 1 })]);
        }
      }

      await Promise.all(nested.map(async ([key, call]) => data[key] = await call));
    }

    return type === ReferenceType.ARRAY ? Object.values(data) : data;
  }

  public incr(key: string, amt: number = 1): PromiseLike<number> {
    if (!key.includes('.')) return Promise.reject(new Error(`key "${key}" does not contain any fields`));
    const isFloat = Math.floor(amt) !== amt;

    const route = key.split('.');
    const field = route.pop();
    if (field && route.length) {
      if (isFloat) return this.client.hincrbyfloat(route.join('.'), field, amt);
      return this.client.hincrby(route.join('.'), field, amt);
    }

    return Promise.reject(new Error(`error parsing key "${key}" for increment`));
  }

  public keys(key: string): PromiseLike<string[]> {
    return this.client.hkeys(key);
  }

  public size(key: string): PromiseLike<number> {
    return this.client.hlen(key);
  }
}

export {
  Reference,
  ReferenceType,
  Rejects,
}
