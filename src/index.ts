import * as path from 'path';
import { actions, log, selectors, types, util } from 'vortex-api';
import { getGameStore, getScriptExtenderVersion, getGamePath, toBlue, clearNotifications, ignoreNotifications } from './util';
import * as gitHubDownloader from './githubDownloader';
import * as nexusModsDownloader from './nexusModsDownloader';
import * as silverlockDownloader from './silverlockDownloader';
import supportData from './gameSupport';
import { testSupported, installScriptExtender } from './installer';
import { IGameSupport } from './types';


async function onCheckModVersion(api: types.IExtensionApi, gameId: string, mods: { [id: string]: types.IMod }) {
  // Clear any update notifications.
  clearNotifications(api, true);

  // Exit if this isn't a supported game.
  if (!supportData[gameId]) { return; }
  const gameSupport: IGameSupport = supportData[gameId];
  if (gameSupport.ignore === true) {
    return;
  }

  //If the script extender has a Nexus Mods page. Exit here as Vortex can check itself.
  if (!!gameSupport.nexusMods) { return; };

  const gamePath = getGamePath(gameId, api);
  const gameStore = getGameStore(gameId, api);
  if (gamePath === undefined || ['xbox', 'epic'].includes(gameStore)) {
    return;
  }

  // Get the version of the installed script extender
  const scriptExtenderVersion: string =
    await getScriptExtenderVersion(path.join(gamePath, gameSupport.scriptExtExe));
  // If there is no script extender installed, return.
  if (!scriptExtenderVersion) { return; }

  // Convert the mods object into an array.
  const modArray = Object.values(mods);
  // Get active profile, so we know which mods are enabled.
  const profile = selectors.activeProfile(api.store.getState());
  // Filter out any non-script extender mods or those which are disabled (old versions).
  const scriptExtenders =
    modArray.filter((mod: types.IMod) => {
      const isScriptExtender = util.getSafe(mod, ['attributes', 'scriptExtender'], false);
      const isEnabled = util.getSafe(profile, ['modState', mod.id, 'enabled'], false);
      const isNotFromNexusMods = mod.attributes?.source !== 'nexus';
      return (isScriptExtender && isEnabled && isNotFromNexusMods);
    });

  // Check for update.
  const latestVersion: string = (!!gameSupport?.gitHubAPIUrl)
    ? await gitHubDownloader.checkForUpdates(api, gameSupport, scriptExtenderVersion)
    : await silverlockDownloader.checkForUpdate(api, gameSupport, scriptExtenderVersion);

  // If we fail to get the latest version or it's an exact match for our
  // installed script extender, return.
  if (!latestVersion || latestVersion === scriptExtenderVersion) { return; }

  // Iterate through our script extenders to add the version update info.
  scriptExtenders.forEach(xse => {
    if (xse.attributes.version !== latestVersion) {
      api.store.dispatch(actions.setModAttributes(gameId, xse.id, {
        newestFileId: 'unknown',
        newestVersion: latestVersion,
      }));
    }
  });
}

async function onGameModeActivated(api: types.IExtensionApi, gameId: string) {
  // Clear script extender notifications from other games.
  clearNotifications(api);

  // If the game is unsupported, exit here.
  if (!supportData[gameId]) {
    return false;
  }
  const gameSupport = supportData[gameId];

  // User has snoozed this notification, this clears each time Vortex is restarted (non-persistent)
  if (gameSupport.ignore === true) {
    return false;
  }

  // Get our game path.
  const activegame: types.IGame = util.getGame(gameId);
  const gamePath = getGamePath(activegame.id, api);
  if (gamePath === undefined) {
    // So the user switched to this gameMode yet we have
    //  no evidence of the game ever being discovered...
    //  makes complete sense!
    //  https://github.com/Nexus-Mods/Vortex/issues/6999
    //  Given that getGamePath _can_ return undefined, we just
    //  return here and avoid testing for script extenders.
    //  pretty sure this issue will pop up again in a different location
    //  unless the user of 6999 gets back to us.
    log('warn', 'user switched to an undiscovered gamemode', gameId);
    return false;
  }

  // Work out which game store the user has. 
  const gameStore = getGameStore(gameId, api);

  // SKSE is not compatible with Xbox Game Pass or Epic Games, so we don't want to notify the user in this case.
  if (['xbox', 'epic'].includes(gameStore)) return;

  // Check for disabled (but installed) script extenders.
  const mods = util.getSafe(api.store.getState(), ['persistent', 'mods', gameId], undefined);
  const modArray: types.IMod[] = mods ? Object.values(mods) : [];
  const installedScriptExtenders =
    modArray.filter(mod => !!mod?.attributes?.scriptExtender).length;
  if (installedScriptExtenders) {
    return;
  }

  // Grab our current script extender version.
  const scriptExtenderVersion: string =
    await getScriptExtenderVersion(path.join(gamePath, gameSupport.scriptExtExe));

  // If the script extender isn't installed, return. Perhaps we should recommend installing it?
  if (!scriptExtenderVersion) {
    if (!!gameSupport?.nexusMods) return nexusModsDownloader.downloadScriptExtender(api, gameSupport);
    else if (!!gameSupport?.gitHubAPIUrl) return gitHubDownloader.downloadScriptExtender(api, gameSupport);
    else return silverlockDownloader.notifyNotInstalled(gameSupport, api);
  }
}

async function testMisconfiguredPrimaryTool(api: types.IExtensionApi): Promise<types.ITestResult> {
  const state = api.store.getState();
  const gameMode = selectors.activeGameId(state);
  const primaryToolId = util.getSafe(state,
    ['settings', 'interface', 'primaryTool', gameMode], undefined);
  if (supportData[gameMode] === undefined || primaryToolId === undefined) {
    // Not applicable.
    return Promise.resolve(undefined);
  }

  const discovery: types.IDiscoveryResult = util.getSafe(state,
    ['settings', 'gameMode', 'discovered', gameMode], undefined);
  if (!discovery?.path || !discovery?.tools?.[primaryToolId]?.path) {
    // No game or no tools.
    return Promise.resolve(undefined);
  }

  
  const gameStore = getGameStore(gameMode, api);

  if (['epic', 'xbox'].includes(gameStore)) {
    return Promise.resolve(undefined);
  }

  const expectedPath = path.join(discovery.path, supportData[gameMode].scriptExtExe);
  
  const installedSEVersion = await getScriptExtenderVersion(expectedPath);
  
  const primaryTool: types.IDiscoveredTool = discovery.tools[primaryToolId];
  const normalize = (input: string, mod?: (input: string) => string) => (mod !== undefined)
    ? path.normalize(mod(input.toLowerCase()))
    : path.normalize(input.toLowerCase());
  if ((installedSEVersion !== undefined)
   && (normalize(primaryTool.path, path.basename) === normalize(supportData[gameMode].scriptExtExe))
   && (normalize(primaryTool.path, path.dirname) !== normalize(discovery.path).replace(/\/$|\\$/, ''))) {
    log('info', `Tool path for ${supportData.name} automatically corrected from ${primaryTool.path} to ${expectedPath}`, primaryTool.id);
    api.store.dispatch(actions.addDiscoveredTool(gameMode, primaryTool.id, {
        ...primaryTool,
        path: expectedPath,
        workingDirectory: discovery.path,
      }, false));
      api.store.dispatch(actions.setToolVisible(gameMode, primaryTool.id, true));
      return Promise.resolve(undefined);

      // We don't need to bother the user with this, we'll just fix it! 
      // return Promise.resolve({
      //   description: {
      //     short: 'Misconfigured Script Extender Tool',
      //     long: t('Your primary tool/starter for this game is a Script Extender, but it appears to be misconfigured. '
      //           + 'Vortex should be able to automatically fix this issue for you by re-configuring it to launch using:[br][/br][br][/br]'
      //           + '{{valid}}[br][/br][br][/br] instead of:[br][/br][br][/br] {{invalid}}[br][/br][br][/br]'
      //           + 'For more information about where/how to install script extenders, please see our wiki article:[br][/br]'
      //           + '[url]https://wiki.nexusmods.com/index.php/Tool_Setup:_Script_Extenders[/url]', {
      //             replace: {
      //               invalid: primaryTool.path,
      //               valid: path.join(discovery.path, path.basename(primaryTool.path)),
      //             },
      //           }),
      //   },
      //   automaticFix: () => {
      //     api.store.dispatch(actions.addDiscoveredTool(gameMode, primaryTool.id, {
      //       ...primaryTool,
      //       path: expectedPath,
      //       workingDirectory: discovery.path,
      //     }, false));
      //     api.store.dispatch(actions.setToolVisible(gameMode, primaryTool.id, true));
      //     return Promise.resolve();
      //   },
      //   severity: 'warning',
      // });
  } else {
    return Promise.resolve(undefined);
  }
}

function main(context: types.IExtensionContext) {
  context.registerInstaller(
    'script-extender-installer', 10, toBlue(testSupported), toBlue(installScriptExtender));

  context.registerTest('misconfigured-script-extender', 'gamemode-activated',
    () => testMisconfiguredPrimaryTool(context.api));
  
  context.once(() => {
    context.api.events.on('gamemode-activated',
      async (gameId: string) => onGameModeActivated(context.api, gameId));
    context.api.events.on('check-mods-version',
      (gameId: string, mods: {[id: string]: types.IMod}) => onCheckModVersion(context.api, gameId, mods));
  });

  return true;
}

export default main;
