import * as http from 'http';
import { IncomingMessage } from 'http';
import * as path from 'path';
import * as semver from 'semver';
import * as url from 'url';
import { actions, log, selectors, types, util } from 'vortex-api';
import { getGameStore, getScriptExtenderVersion, getGamePath, toBlue, clearNotifications, ignoreNotifications } from './util';
import * as gitHubDownloader from './githubDownloader';
import * as nexusModsDownloader from './nexusModsDownloader';
import supportData from './gameSupport';
import { testSupported, installScriptExtender } from './installer';
import { IGameSupport } from './types';


async function onCheckModVersion(api: types.IExtensionApi, gameId: string, mods: { [id: string]: types.IMod }) {
  // Clear any update notifications.
  clearNotifications(api, true);

  // Exit if this isn't a supported game.
  if (!supportData[gameId]) { return; }
  const gameSupport = supportData[gameId];
  if (gameSupport.ignore === true) {
    return;
  }
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
    : await checkForUpdate(api, gameSupport, scriptExtenderVersion);

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
    else return notifyNotInstalled(gameSupport, api);
  }
}

function checkForUpdate(api: types.IExtensionApi,
                        gameSupport: IGameSupport,
                        scriptExtenderVersion: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(gameSupport.website);
    //const lib = parsed.protocol === 'https:' ? https : http;
    const lib = http;
    lib.get(parsed, (res: IncomingMessage) => {
      const { statusCode } = res;
      if (statusCode !== 200) { return resolve(scriptExtenderVersion); }
      res.setEncoding('utf8');
      let rawData = '';
      res.on('data', (chunk) => rawData += chunk);
      res.on('end', () => {
      try {
        // We just loaded the Script Extender website. Find our download link.
        const urlpath: string = rawData.match(gameSupport.regex)[0];

        // Remove the beta tag for the file name.
        const splitName: string[] = urlpath.split(path.sep);

        // Pop the last item in the array (file name)
        const downloadName: string = splitName.pop().toString();

        // We need to clean this up to make it semantic.
        // By replacing underscores with dots, replacing double zeros with single zeros
        // and removing leading zeros.
        // If we choose not to download directly, the regex can be adjusted to find the
        // version in the text.
        const newVersion: string = downloadName
          .match(/_([0-9]+_[0-9]+_[0-9a-z]+)/i)[1]
          .replace(/\_/g, '.')
          .replace(/([a-z]+)/g, '')
          .replace(/[0]+/g, '0')
          .replace(/(0)[1-9]/g, (replacement) => replacement.replace('0', ''));

        // If it's still not semantic, try coercing it.
        const latestVersion: string = semver.valid(newVersion)
                                    ? newVersion
                                    : semver.coerce(newVersion).version;

        // If it's STILL not valid, exit here.
        if (!semver.valid(latestVersion)) {
          return resolve(scriptExtenderVersion);
        }
        log('debug', 'Latest Version script extender', [gameSupport.name, latestVersion]);

        // If the version from the website is greater than the installed version, inform the user.
        if (semver.gt(latestVersion, scriptExtenderVersion)) {
          notifyNewVersion(latestVersion, scriptExtenderVersion, gameSupport, api);
        }

        return resolve(latestVersion);
        } catch (err) {
          log('warn', 'Error geting script extender data', err.message);
          return resolve(scriptExtenderVersion);
        }
      });
    }).on('error', (err: Error) => {
      log('warn', 'Error getting script extender data', err.message);
      return resolve(scriptExtenderVersion);
    });
  });
}

function dialogActions(api: types.IExtensionApi,
                       gameSupportData: IGameSupport,
                       dismiss: () => void): types.IDialogAction[] {
  const t = api.translate;
  const state = api.store.getState();
  const activeProfile: types.IProfile = selectors.activeProfile(state);
  return [
    {
      label: 'Ignore',
      action: () => {
        // Ignore this update until Vortex is restarted.
        gameSupportData.ignore = true;
        dismiss();
      },
    },
    {
      label: 'Open in Vortex',
      action: () => {
        const instructions =
          t('To install {{name}}, download the latest 7z archive for {{gameName}}.',
            { replace:
              {
                name: gameSupportData.name,
                gameName: (gameSupportData.gameName),
              },
            });
        // Open the script extender site in Vortex.
        api.emitAndAwait('browse-for-download', gameSupportData.website, instructions)
        .then((result: string[]) => {
          if (!result || !result.length) {
            // If the user clicks outside the window without downloading.
            return Promise.reject(new util.UserCanceled());
          }
          const downloadUrl = result[0].indexOf('<') ? result[0].split('<')[0] : result[0];
          const correctFile = downloadUrl.match(gameSupportData.regex);
          if (!!correctFile) {
            const dlInfo = {
              game: gameSupportData.gameId,
              name: gameSupportData.name,
            };
            api.events.emit('start-download', [downloadUrl], dlInfo, undefined,
              (error, id) => {
                if (error !== null) {
                  if ((error.name === 'AlreadyDownloaded')
                      && (error.downloadId !== undefined)) {
                    // if the file was already downloaded then that's fine, just install
                    // that file
                    id = error.downloadId;
                  } else {
                    // Possibly redundant error notification ?
                    api.showErrorNotification('Download failed',
                      error, { allowReport: false });
                    dismiss();
                    return Promise.resolve();
                  }
                }
                api.events.emit('start-install-download', id, true, async (err, modId) => {
                  if (err) {
                    // Error notification gets reported by the event listener
                    log('error', 'Error installing download', err.message);
                  } else {
                    // It's safe to assume that if the user chose to download and install
                    //  the new script extender, he also expects it to be enabled and deployed
                    //  straight away.
                    if (activeProfile?.id !== undefined) {
                      // Disable existing SE mods
                      const mods = util.getSafe(api.store.getState(),
                        ['persistent', 'mods', activeProfile.gameId], {});

                      const modArray = Object.keys(mods).map(k => mods[k]);
                      const scriptExtenders = modArray.filter(mod => {
                        const isScriptExtender = util.getSafe(mod,
                          ['attributes', 'scriptExtender'], false);

                        const isEnabled = util.getSafe(activeProfile,
                          ['modState', mod.id, 'enabled'], false);

                        return (isScriptExtender && isEnabled);
                      });
                      // Disable any other copies of the script extender
                      scriptExtenders.forEach(se =>
                        api.store.dispatch(actions.setModEnabled(activeProfile.id, se.id, false)));
                      // Enable the new script extender mod
                      api.store.dispatch(actions.setModEnabled(activeProfile.id, modId, true));
                      // Force-deploy the xSE files
                      await api.emitAndAwait('deploy-single-mod', activeProfile.gameId, modId, true);
                      // Refresh the tools dashlet (does this actually work?)
                      await api.emitAndAwait('discover-tools', activeProfile.gameId);
                      // Set the xSE tool as primary. 
                      api.store.dispatch(
                        { type: 'SET_PRIMARY_TOOL', 
                          payload: { 
                            gameId: activeProfile.gameId, 
                            toolId: gameSupportData.toolId 
                          } 
                        }
                      );
                      // api.store.dispatch(
                      //   actions.setDeploymentNecessary(activeProfile.gameId, true)
                      // );
                    }
                  }
                  dismiss();
                  return Promise.resolve();
                });
              }, 'never', { allowInstall: false });
          } else {
            api.sendNotification({
              type: 'warning',
              id: 'scriptextender-wrong',
              title: t('Script Extender Mismatch - {{file}}',
                { replace: { file: path.basename(downloadUrl) } }),
              message: t('Looks like you selected the wrong file. Please try again.'),
            });
          }
        })
        .catch(err => {
          if (err instanceof util.UserCanceled) {
            return log('info', 'User clicked outside the browser without downloading. Script extender update cancelled.');
          }
          api.showErrorNotification('Error browsing for download', err);
        });
      },
    },
    {
      label: 'Open in browser',
      action: () => {
        // Open the script extender site in Vortex.
        util.opn(gameSupportData.website).catch(() => undefined);
        dismiss();
      },
    },
  ];
}

// could add url : string[], for the download URL
function notifyNewVersion(latest: string,
                          current: string,
                          gameSupportData: IGameSupport,
                          api: types.IExtensionApi) {
  // Raise a notification.
  api.sendNotification({
    type: 'info',
    id: `scriptextender-update-${gameSupportData.gameId}`,
    allowSuppress: true,
    title: 'Update for {{name}}',
    message: 'Latest: {{latest}}, Installed: {{current}}',
    replace: {
      name: gameSupportData.name,
      latest,
      current,
    },
    actions: [
      { title : 'More', action: (dismiss: () => void) => {
          api.showDialog('info', 'Script Extender Update', {
            text: 'Vortex has detected a newer version of {{name}} ({{latest}}) available to download from {{website}}. You currently have version {{current}} installed.'
            + '\nThe buttons below will open the script extender download page where you can download it directly into Vortex or through your browser. Please ensure you select the correct build for your game version. '
            + '\n\nIf you ignore this message, Vortex will not remind you again until you restart it.',
            parameters: {
              name: gameSupportData.name,
              latest,
              website: gameSupportData.website,
              current,
            },
          }, dialogActions(api, gameSupportData, dismiss));
        },
      }],
  });
}

function notifyNotInstalled(gameSupportData: IGameSupport, api: types.IExtensionApi) {
  const t = api.translate;

  api.sendNotification({
    type: 'info',
    id: `scriptextender-missing-${gameSupportData.gameId}`,
    allowSuppress: true,
    message: '{{name}} not installed',
    replace: { name: gameSupportData.name },
    actions: [
      {
        title: 'More',
        action: (dismiss) => {
          api.showDialog('info', `{{name}} not found`, {
            text: 'Vortex could not detect {{name}}. This means it is either not installed or installed incorrectly.'
            + '\n\nFor the best modding experience, we recommend installing the script extender by visiting {{website}}, Vortex can open the download page using the options below.'
            + '\n\nIf you ignore this notice, Vortex will not remind you again until it is restarted.',
            parameters: { name: gameSupportData.name, website: gameSupportData.website },
          }, dialogActions(api, gameSupportData, dismiss));
        },
      },
    ],
  });
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
