import * as Bluebird from 'bluebird';
import getVersion from 'exe-version';
import * as http from 'http';
import * as https from 'https';
import { IncomingMessage } from 'http';
import * as path from 'path';
import * as semver from 'semver';
import * as url from 'url';
import * as _ from 'lodash';
import { actions, fs, log, selectors, types, util } from 'vortex-api';

import * as gitHubDownloader from './githubDownloader';
import { IGameSupport, IModsDict } from './types';
import * as xseAttributes from './xse-attributes.json';

const supportData: { [gameId: string]: IGameSupport } = {
  skyrim: {
    name: 'Skyrim Script Extender (SKSE)',
    gameName: 'Skyrim',
    gameId: 'skyrim',
    scriptExtExe: 'skse_loader.exe',
    website: 'https://skse.silverlock.org/',
    regex: /(beta\/skse_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.skyrim];
    },
  },
  skyrimse: {
    name: 'Skyrim Script Extender 64 (SKSE64)',
    gameName: 'Skyrim SE',
    gameId: 'skyrimse',
    scriptExtExe: 'skse64_loader.exe',
    website: 'https://skse.silverlock.org/',
    regex: /(beta\/skse64_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.skyrimse];
    },
  },
  skyrimvr: {
    name: 'Skyrim Script Extender VR (SKSEVR)',
    gameName: 'Skyrim VR',
    gameId: 'skyrimvr',
    scriptExtExe: 'sksevr_loader.exe',
    website: 'https://skse.silverlock.org/',
    regex: /(beta\/sksevr_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.skyrimvr];
    },
  },
  fallout4: {
    name: 'Fallout 4 Script Extender (F4SE)',
    gameName: 'Fallout 4',
    gameId: 'fallout4',
    scriptExtExe: 'f4se_loader.exe',
    website: 'https://f4se.silverlock.org/',
    regex: /(beta\/f4se_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.fallout4];
    },
  },
  fallout4vr: {
    name: 'Fallout 4 Script Extender VR (F4SE)',
    gameName: 'Fallout 4 VR',
    gameId: 'fallout4vr',
    scriptExtExe: 'f4sevr_loader.exe',
    website: 'https://f4se.silverlock.org/',
    regex: /(beta\/f4sevr_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.fallout4vr,
      ];
    },
  },
  falloutnv: {
    name: 'New Vegas Script Extender (NVSE)',
    gameName: 'Fallout NV',
    gameId: 'falloutnv',
    scriptExtExe: 'nvse_loader.exe',
    website: 'https://github.com/xNVSE/NVSE/',
    regex: /(nvse_[0-9]+_[0-9]+_[a-zA-Z0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.falloutnv];
    },
    gitHubAPIUrl: 'https://api.github.com/repos/xNVSE/NVSE',
  },
  fallout3: {
    name: 'Fallout Script Extender (FOSE)',
    gameName: 'Fallout 3',
    gameId: 'fallout3',
    scriptExtExe: 'fose_loader.exe',
    website: 'https://fose.silverlock.org/',
    regex: /(download\/fose_v[0-9]+_[0-9]+_[a-zA-Z0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.fallout3];
    },
  },
  oblivion: {
    name: 'Oblivion Script Extender (OBSE)',
    gameName: 'Oblivion',
    gameId: 'oblivion',
    scriptExtExe: 'obse_loader.exe',
    website: 'https://obse.silverlock.org/',
    regex: /(download\/obse_[0-9]+.zip)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.oblivion];
    },
  },
};

const getScriptExtenderVersion = (extenderPath: string): Promise<string> => {
  // Check the file we're looking for actually exists.
  return new Promise((resolve, reject) => {
    fs.statAsync(extenderPath)
    .then(() => {
      // The exe versions appear to have a leading zero. So we need to cut it off.
      let exeVersion = getVersion(extenderPath);
      exeVersion = exeVersion.startsWith('0')
        ? exeVersion.substr(exeVersion.indexOf('.'), exeVersion.length)
        : exeVersion;
      return resolve(semver.coerce(exeVersion).version);
    })
    .catch(() => {
      // Return a blank string if the file doesn't exist.
      log('debug', 'Script extender not found:', extenderPath);
      return resolve(undefined);
    });

  });
};

const getGamePath = (gameId: string, api): string => {
  const state: types.IState = api.store.getState();
  const discovery = state.settings.gameMode.discovered[gameId];
  if (discovery !== undefined) {
    return discovery.path;
  } else {
    return undefined;
  }
};

function testScriptExtender(instructions, api: types.IExtensionApi): Promise<boolean> {
  const copies = instructions.filter(instruction => instruction.type === 'copy');
  const gameId = selectors.activeGameId(api.store.getState());
  const exeName = supportData[gameId].scriptExtExe;
  return new Promise((resolve, reject) => {
    return resolve(copies.find(file => path.basename(file.destination) === exeName) !== undefined);
  });
}

function isXboxVersion(discoveryPath: string): boolean {
  // Check if this is the xbox game pass variant of the game - script extenders
  //  are not supported (yet).
  const hasPathElement = (element) =>
    discoveryPath.toLowerCase().includes(element);
  return ['modifiablewindowsapps', '3275kfvn8vcwc'].find(hasPathElement) !== undefined;
}

function onModsStateChange(api: types.IExtensionApi, prev: IModsDict, cur: IModsDict) {
  const state = api.getState();
  const activeGameId = selectors.activeGameId(state);
  const gameSupportData = supportData[activeGameId];
  if (!gameSupportData) {
    return;
  }

  const prevG = prev[activeGameId] ?? {};
  const curG = cur[activeGameId] ?? {};
  const allIds =
    Array.from(new Set([].concat(Object.keys(prev[activeGameId]), Object.keys(cur[activeGameId]))));
  const collections = allIds.filter(id =>
    (prevG[id]?.type === 'collection') || (curG[id]?.type === 'collection'));

  for (const id of collections) {
    if (prevG[id]?.rules === curG[id]?.rules) {
      continue;
    }

    const added = _.difference(curG[id]?.rules, prevG[id]?.rules);
    const scriptExtenders = added.map(rule => {
      const isInCollection = ['requires', 'recommends'].includes(rule.type);
      const mod = curG[rule.reference?.['id']];
      if (!mod) {
        return undefined;
      }
      const isScriptExtender = (mod.attributes?.scriptExtender === true);
      return (isInCollection && isScriptExtender) ? mod : undefined;
    }).filter(mod => !!mod);

    if (scriptExtenders.length === 0) {
      continue;
    }

    const attributes = util.getSafe(curG[id], ['attributes'], {});
    const collectionAttribute = attributes['collection'] ?? {};
    const t = api.translate;
    const instructions = t('To install {{name}}, download the latest 7z archive for {{gameName}}.',
      { replace: { name: gameSupportData.name, gameName: (gameSupportData.gameName), },
    });
    scriptExtenders.forEach(se => {
      collectionAttribute['source'] = {
        ...collectionAttribute['source'],
        [se.id]: {
          instructions,
          type: 'browse',
          url: gameSupportData.gitHubAPIUrl || gameSupportData.website,
        },
      }
    });

    api.store.dispatch(actions.setModAttributes(activeGameId, id, {
      ...attributes,
      collection: collectionAttribute,
    }));
  }
}

async function onCheckModVersion(api, gameId, mods) {
  // Clear any update notifications.
  clearNotifications(api, true);

  // Exit if this isn't a supported game.
  if (!supportData[gameId]) { return; }
  const gameSupport = supportData[gameId];
  if (gameSupport.ignore === true) {
    return;
  }
  const gamePath = getGamePath(gameId, api);
  if (gamePath === undefined || isXboxVersion(gamePath)) {
    return;
  }

  // Get the version of the installed script extender
  const scriptExtenderVersion: string =
    await getScriptExtenderVersion(path.join(gamePath, gameSupport.scriptExtExe));
  // If there is no script extender installed, return.
  if (!scriptExtenderVersion) { return; }

  // Convert the mods object into an array.
  const modArray = Object.keys(mods).map(k => mods[k]);
  // Get active profile, so we know which mods are enabled.
  const profile = selectors.activeProfile(api.store.getState());
  // Filter out any non-script extender mods or those which are disabled (old versions).
  const scriptExtenders =
    modArray.filter(mod => {
      const isScriptExtender = util.getSafe(mod, ['attributes', 'scriptExtender'], false);
      const isEnabled = util.getSafe(profile, ['modState', mod.id, 'enabled'], false);
      return (isScriptExtender && isEnabled);
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

  if (isXboxVersion(gamePath)) {
    return;
  }

  // Check for disabled (but installed) script extenders.
  const mods = util.getSafe(api.store.getState(), ['persistent', 'mods', gameId], undefined);
  const modArray = mods ? Object.keys(mods).map(k => mods[k]) : undefined;
  const installedScriptExtenders =
    modArray ? modArray.filter(mod => !!mod?.attributes?.scriptExtender).length : 0;
  if (installedScriptExtenders) {
    return;
  }

  // Grab our current script extender version.
  const scriptExtenderVersion: string =
    await getScriptExtenderVersion(path.join(gamePath, gameSupport.scriptExtExe));

  // If the script extender isn't installed, return. Perhaps we should recommend installing it?
  if (!scriptExtenderVersion) {
    return (!!gameSupport?.gitHubAPIUrl)
      ? gitHubDownloader.downloadScriptExtender(api, gameSupport)
      : notifyNotInstalled(gameSupport, api);
  }
}

function checkForUpdate(api: types.IExtensionApi,
                        gameSupport: IGameSupport,
                        scriptExtenderVersion: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(gameSupport.website);
    const lib = parsed.protocol === 'https:' ? https : http;
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
                api.events.emit('start-install-download', id, true, (err, modId) => {
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
                      scriptExtenders.forEach(se =>
                        api.store.dispatch(actions.setModEnabled(activeProfile.id, se.id, false)));
                      api.store.dispatch(actions.setModEnabled(activeProfile.id, modId, true));
                      api.store.dispatch(
                        actions.setDeploymentNecessary(activeProfile.gameId, true));
                    }
                  }
                  dismiss();
                  return Promise.resolve();
                });
              }, 'never');
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
        util.opn(gameSupportData.website).catch(err => undefined);
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

function clearNotifications(api, preserveMissing?: boolean) {
  Object.keys(supportData).forEach(key => {
    if (!preserveMissing) {
      api.dismissNotification(`scriptextender-missing-${key}`);
    }
    api.dismissNotification(`scriptextender-update-${key}`);
  });
}

function testSupported(files: string[], gameId: string): Promise<types.ISupportedResult> {
  return new Promise((resolve, reject) => {
    if (!supportData[gameId]) {
      return resolve({ supported: false, requiredFiles: [] });
    } // Not a script extender friendly game.
    const scriptExtender =
      files.find((file) => path.basename(file) === supportData[gameId].scriptExtExe);
    resolve({ supported: scriptExtender ? true : false, requiredFiles: [] });
  });
}

async function installScriptExtender(files: string[], destinationPath: string, gameId: string)
    : Promise<types.IInstallResult> {
  // Install the script extender.
  const gameData = supportData[gameId];
  const scriptExtender =
    files.find(file => path.basename(file).toLowerCase() === gameData.scriptExtExe.toLowerCase());
  const idx = scriptExtender.indexOf(path.basename(scriptExtender));
  const rootPath = path.dirname(scriptExtender);

  // Get the attribute data we need.
  const scriptExtenderVersion =
    await getScriptExtenderVersion(path.join(destinationPath, scriptExtender));
  const attributes = gameData.attributes(scriptExtenderVersion);
  // Include rules to make this conflict with any other script extender versions.
  attributes.push(
    {
      type: 'rule',
      rule: {
        reference: {
          logicalFileName: gameData.name,
          versionMatch: `<${scriptExtenderVersion} || >${scriptExtenderVersion}`,
        },
        type: 'conflicts',
        comment: 'Incompatible Script Extender',
      },
    },
  );

  // Remove directories and anything that isn't in the rootPath.
  const filtered = files.filter(file =>
    ((file.indexOf(rootPath) !== -1)
    && (!file.endsWith(path.sep))));

  // Build install instructions and attach attributes to it.
  const instructions: types.IInstruction[] = filtered.map(file => {
    const copy: types.IInstruction = {
      type: 'copy' as 'copy',
      source: file,
      destination: path.join(file.substr(idx)),
    };
    return copy;
  }).concat(attributes);

  // TODO: remove this once we had a chance to fix the modtypes conflict issue
  //  and have re-instated the script-extender modtype.
  instructions.push({ type: 'setmodtype', value: 'dinput' });

  return Promise.resolve({ instructions });
}

function toBlue<T>(func: (...args: any[]) => Promise<T>): (...args: any[]) => Bluebird<T> {
  return (...args: any[]) => Bluebird.resolve(func(...args));
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

  if (isXboxVersion(discovery.path)) {
    return Promise.resolve(undefined);
  }

  const installedSEVersion = await getScriptExtenderVersion(
    path.join(discovery.path, supportData[gameMode].scriptExtExe));

  const t = api.translate;
  const primaryTool: types.IDiscoveredTool = discovery.tools[primaryToolId];
  const normalize = (input: string, mod?: (input: string) => string) => (mod !== undefined)
    ? path.normalize(mod(input.toLowerCase()))
    : path.normalize(input.toLowerCase());
  if ((installedSEVersion !== undefined)
   && (normalize(primaryTool.path, path.basename) === normalize(supportData[gameMode].scriptExtExe))
   && (normalize(primaryTool.path, path.dirname) !== normalize(discovery.path).replace(/\/$|\\$/, ''))) {
      return Promise.resolve({
        description: {
          short: 'Misconfigured Script Extender Tool',
          long: t('Your primary tool/starter for this game is a Script Extender, but it appears to be misconfigured. '
                + 'Vortex should be able to automatically fix this issue for you by re-configuring it to launch using:[br][/br][br][/br]'
                + '{{valid}}[br][/br][br][/br] instead of:[br][/br][br][/br] {{invalid}}[br][/br][br][/br]'
                + 'For more information about where/how to install script extenders, please see our wiki article:[br][/br]'
                + '[url]https://wiki.nexusmods.com/index.php/Tool_Setup:_Script_Extenders[/url]', {
                  replace: {
                    invalid: primaryTool.path,
                    valid: path.join(discovery.path, path.basename(primaryTool.path)),
                  },
                }),
        },
        automaticFix: () => {
          api.store.dispatch(actions.addDiscoveredTool(gameMode, primaryTool.id, {
            ...primaryTool,
            path: path.join(discovery.path, supportData[gameMode].scriptExtExe),
            workingDirectory: discovery.path,
          }, false));
          api.store.dispatch(actions.setToolVisible(gameMode, primaryTool.id, true));
          return Promise.resolve();
        },
        severity: 'warning',
      });
  } else {
    return Promise.resolve(undefined);
  }
}

function main(context: types.IExtensionContext) {
  context.registerInstaller(
    'script-extender-installer', 10, toBlue(testSupported), toBlue(installScriptExtender));

  context.registerTest('misconfigured-script-extender', 'gamemode-activated',
    () => testMisconfiguredPrimaryTool(context.api));

  // Commenting the modtype out as Vortex currently is not able to detect conflicts between
  //  modtypes and we've confirmed that this can cause unexpected behaviour
  //  as seen in https://github.com/Nexus-Mods/Vortex/issues/6307.
  // context.registerModType(
  //   'script-extender', 10,
  //   (game) => supportData[game] !== undefined,
  //   (game: types.IGame) =>
  //     getGamePath(game.id, context.api),
  //   (instructions) => testScriptExtender(instructions, context.api),
  //   { mergeMods: true, name: 'Script Extender' });
  context.once(() => {
    context.api.events.on('gamemode-activated',
      async (gameId: string) => onGameModeActivated(context.api, gameId));
    context.api.events.on('check-mods-version',
      (gameId: string, mods: types.IMod[]) => onCheckModVersion(context.api, gameId, mods));
    context.api.onStateChange(['persistent', 'mods'],
      (prev: IModsDict, cur: IModsDict) => onModsStateChange(context.api, prev, cur));
  });

  return true;
}

export function ignoreNotifications(gameSupport: IGameSupport) {
  // Allows the github downloader to set the ignore flag.
  const match = Object.keys(supportData).find(key => key === gameSupport.gameId);
  supportData[match].ignore = true;
}

export default main;
