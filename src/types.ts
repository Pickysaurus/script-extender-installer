import { types } from 'vortex-api';

export interface IGameSupport {
  name: string;
  scriptExtExe: string;
  website: string;
  regex: RegExp;
  attributes: (ver: string) => types.IInstruction[];
  latestVersion: string;
  ignore?: boolean;
  gitHubAPIUrl?: string;
}
