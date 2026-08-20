declare module 'passport' {
  import { Request } from 'express';
  export function initialize(): any;
  export function session(): any;
  export function authenticate(name: string, options?: any): any;
  export function serializeUser(fn: any): void;
  export function deserializeUser(fn: any): void;
  export function use(name: string, strategy: any): void;
}

declare module 'passport-google-oauth20' {
  import { Strategy } from 'passport';
  export class Strategy extends any {
    constructor(options: any, verify: any);
  }
}

declare module 'passport-github2' {
  import { Strategy } from 'passport';
  export class Strategy extends any {
    constructor(options: any, verify: any);
  }
}
