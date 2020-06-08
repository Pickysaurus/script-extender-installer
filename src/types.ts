import { types } from 'vortex-api';

export interface IGameSupport {
  name: string;
  gameId: string;
  scriptExtExe: string;
  website: string;
  regex: RegExp;
  attributes: (ver: string) => types.IInstruction[];
  latestVersion: string;
  // latest version display should only be used if
  //  the script extender version on the download page
  //  differs from the actual semantic version of the SE
  latestVersionDisplay?: string;
  ignore?: boolean;
  gitHubAPIUrl?: string;
}
