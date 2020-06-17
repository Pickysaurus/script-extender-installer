import * as Bluebird from 'bluebird';
import getVersion from 'exe-version';
import * as http from 'http';
import { IncomingMessage } from 'http';
import * as path from 'path';
import * as semver from 'semver';
import { actions, fs, log, selectors, types, util } from 'vortex-api';

import * as gitHubDownloader from './githubDownloader';
import { IGameSupport } from './types';
import * as xseAttributes from './xse-attributes.json';

const supportData: { [gameId: string]: IGameSupport } = {
  skyrim: {
    name: 'Skyrim Script Extender (SKSE)',
    gameId: 'skyrim',
    scriptExtExe: 'skse_loader.exe',
    website: 'https://skse.silverlock.org/',
    regex: /(beta\/skse_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.skyrim];
    },
    latestVersion: '1.7.3',
  },
  skyrimse: {
    name: 'Skyrim Script Extender 64 (SKSE64)',
    gameId: 'skyrimse',
    scriptExtExe: 'skse64_loader.exe',
    website: 'https://skse.silverlock.org/',
    regex: /(beta\/skse64_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.skyrimse];
    },
    latestVersion: '2.0.17',
  },
  skyrimvr: {
    name: 'Skyrim Script Extender VR (SKSEVR)',
    gameId: 'skyrimvr',
    scriptExtExe: 'sksevr_loader.exe',
    website: 'https://skse.silverlock.org/',
    regex: /(beta\/sksevr_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.skyrimvr];
    },
    latestVersion: '2.0.11',
  },
  fallout4: {
    name: 'Fallout 4 Script Extender (F4SE)',
    gameId: 'fallout4',
    scriptExtExe: 'f4se_loader.exe',
    website: 'https://f4se.silverlock.org/',
    regex: /(beta\/f4se_[0-9]+_[0-9]+_[0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.fallout4];
    },
    latestVersion: '0.6.21',
  },
  fallout4vr: {
    name: 'Fallout 4 Script Extender VR (F4SE)',
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
    latestVersion: '0.6.20',
  },
  falloutnv: {
    name: 'New Vegas Script Extender (NVSE)',
    gameId: 'falloutnv',
    scriptExtExe: 'nvse_loader.exe',
    website: 'https://github.com/xNVSE/NVSE/',
    regex: /(nvse_[0-9]+_[0-9]+_[a-zA-Z0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.falloutnv];
    },
    latestVersion: '5.1.6',
    gitHubAPIUrl: 'https://api.github.com/repos/xNVSE/NVSE',
  },
  fallout3: {
    name: 'Fallout Script Extender (FOSE)',
    gameId: 'fallout3',
    scriptExtExe: 'fose_loader.exe',
    website: 'https://fose.silverlock.org/',
    regex: /(download\/fose_v[0-9]+_[0-9]+_[a-zA-Z0-9]+.7z)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.fallout3];
    },
    latestVersion: '1.2.2',
  },
  oblivion: {
    name: 'Oblivion Script Extender (OBSE)',
    gameId: 'oblivion',
    scriptExtExe: 'obse_loader.exe',
    website: 'https://obse.silverlock.org/',
    regex: /(download\/obse_[0-9]+.zip)/i,
    attributes: (xseVersion) => {
      return [
        { type: 'attribute', key: 'version', value: xseVersion } as any,
        ...xseAttributes.oblivion];
    },
    latestVersion: '0.21.4',
    latestVersionDisplay: '0021',
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
      return resolve();
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
    modArray.filter(mod => (!!mod?.attributes?.scriptExtender)
      && !!profile.modState[mod.id]?.enabled);

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

  // If we've already stored the latest version this session and it's out of date.
  if (gameSupport.latestVersion && semver.gt(gameSupport.latestVersion, scriptExtenderVersion)) {
    return notifyNewVersion(gameSupport.latestVersion, scriptExtenderVersion, gameSupport, api);
  } else if (!gameSupport.latestVersion) {
    return checkForUpdate(api, gameSupport, scriptExtenderVersion);
  }
}

function checkForUpdate(api: types.IExtensionApi,
                        gameSupport: IGameSupport,
                        scriptExtenderVersion: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(gameSupport.website, {protocol : 'http:'}, (res: IncomingMessage) => {
      const { statusCode } = res;
      if (statusCode !== 200) { return resolve(gameSupport.latestVersion); }
      res.setEncoding('utf8');
      let rawData = '';
      res.on('data', (chunk) => rawData += chunk);
      res.on('end', () => {
        try {
          // We just loaded the Script Extender Website website. Find our download link.
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
          return resolve(gameSupport.latestVersion);
        }
        log('debug', 'Latest Version script extender', [gameSupport.name, latestVersion]);

        // Save this value so we don't have to check again this session.
        gameSupport.latestVersion = latestVersion;

        // If the version from the website is greater than the installed version, inform the user.
        if (semver.gt(latestVersion, scriptExtenderVersion)) {
          notifyNewVersion(latestVersion, scriptExtenderVersion, gameSupport, api);
        }

        return resolve(latestVersion);
        } catch (err) {
          log('error', 'Error geting script extender data', err);
          return resolve(gameSupport.latestVersion);
        }
      });
    }).on('error', (err: Error) => {
      log('error', 'Error getting script extender data', err);
      return resolve(gameSupport.latestVersion);
    });
  });
}

function dialogActions(api: types.IExtensionApi,
                       gameSupportData: IGameSupport,
                       dismiss: () => void): types.IDialogAction[] {
  const t = api.translate;
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
          t('To install {{name}}, download the 7z archive for {{latest}}.',
            { replace:
              {
                name: gameSupportData.name,
                latest: (!!gameSupportData?.latestVersionDisplay)
                  ? gameSupportData.latestVersionDisplay : gameSupportData.latestVersion,
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
                    log('error', 'Error installing download', err);
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
          return log('error', 'Error browsing for download', err);
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
          api.showDialog('info', `${gameSupportData.name} not found`, {
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

function main(context: types.IExtensionContext) {
  context.registerInstaller(
    'script-extender-installer', 10, toBlue(testSupported), toBlue(installScriptExtender));

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
  });

  return true;
}

export function ignoreNotifications(gameSupport: IGameSupport) {
  // Allows the github downloader to set the ignore flag.
  const match = Object.keys(supportData).find(key => key === gameSupport.gameId);
  supportData[match].ignore = true;
}

export default main;
