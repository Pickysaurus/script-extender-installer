import { types } from 'vortex-api';

export interface IGameSupport {
  name: string;
  gameId: string;
  gameName: string;
  scriptExtExe: string;
  website: string;
  regex: RegExp;
  attributes: (ver: string) => types.IInstruction[];
  ignore?: boolean;
  gitHubAPIUrl?: string;
}

export interface IModsDict { [gameId: string]: { [modId: string]: types.IMod }; }
