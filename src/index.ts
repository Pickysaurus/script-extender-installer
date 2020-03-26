import { actions, fs, log, selectors, types, util } from 'vortex-api';
import * as path from 'path';
import * as https from 'https';
import { IncomingMessage } from 'http';
import getVersion from 'exe-version';
import * as semver from 'semver';

let supportData ={
  "skyrim" : {
    name: "Skyrim Script Extender (SKSE)",
    scriptExtExe: "skse_loader.exe",
    nexusPage: "https://www.nexusmods.com/skyrim/mods/100216",
    nexusGameId: 110,
    nexusModId: 100216,
    website: "http://skse.silverlock.org/",
    regex: /(beta\/skse_[0-9]+_[0-9]+_[0-9]+.7z)/i
  },
  "skyrimse" : {
    name: "Skyrim Script Extender 64 (SKSE64)",
    scriptExtExe: "skse64_loader.exe",
    nexusPage: "https://www.nexusmods.com/skyrimspecialedition/mods/30379",
    nexusGameId: 1704,
    nexusModId: 30379,
    website: "http://skse.silverlock.org/",
    regex: /(beta\/skse64_[0-9]+_[0-9]+_[0-9]+.7z)/i
  },
  "skyrimvr" : {
    name: "Skyrim Script Extender VR (SKSEVR)",
    scriptExtExe: "sksevr_loader.exe",
    nexusPage: "https://www.nexusmods.com/skyrim/mods/100238",
    nexusGameId: 1704,
    nexusModId: 100238,
    website: "http://skse.silverlock.org/",
    regex: /(beta\/sksevr_[0-9]+_[0-9]+_[0-9]+.7z)/i
  },
  "fallout4" : {
    name: "Fallout 4 Script Extender (F4SE)",
    scriptExtExe: "f4se_loader.exe",
    nexusPage: "https://www.nexusmods.com/fallout4/mods/42147",
    nexusGameId: 1151,
    nexusModId: 42147,
    website: "http://f4se.silverlock.org/",
    regex: /(beta\/f4se_[0-9]+_[0-9]+_[0-9]+.7z)/i
  },
  "fallout4vr" : {
    name: "Fallout 4 Script Extender VR (F4SE)",
    scriptExtExe: "f4vser_loader.exe",
    nexusPage: "https://www.nexusmods.com/fallout4/mods/42147",
    nexusGameId: 1151,
    nexusModId: 42147,
    website: "http://f4se.silverlock.org/",
    regex: /(beta\/f4sevr_[0-9]+_[0-9]+_[0-9]+.7z)/i
  },
  "falloutnv" : {
    name: "New Vegas Script Extender (NVSE)",
    scriptExtExe: "nvse_loader.exe",
    nexusPage: "https://www.nexusmods.com/newvegas/mods/67883",
    nexusGameId: 1151,
    nexusModId: 67883,
    website: "http://nvse.silverlock.org/",
    regex: /(download\/nvse_[0-9]+_[0-9]+_[a-zA-Z0-9]+.7z)/i
  },
  "fallout3" : {
    name: "Fallout Script Extender (FOSE)",
    scriptExtExe: "fose_loader.exe",
    nexusPage: "https://www.nexusmods.com/fallout3/mods/8606",
    nexusGameId: 1151,
    nexusModId: 8606,
    website: "http://fose.silverlock.org/",
    regex: /(download\/obse_[0-9]+.zip)/i
  },
  "oblivion" : {
    name: "Oblivion Script Extender (OBSE)",
    scriptExtExe: "obse_loader.exe",
    nexusPage: "https://www.nexusmods.com/oblivion/mods/37952",
    nexusGameId: 1151,
    nexusModId: 37952,
    website: "http://obse.silverlock.org/",
    regex: /(download\/fose_[0-9]+_[0-9]+_[a-zA-Z0-9]+.7z)/i
  },
  //MWSE is only on Nexus Mods or Github, so will have to be handled differently. 
  "morrowind" : {
    name: "Morrowind Script Extender (MWSE)",
    scriptExtExe: "MWSE.dll",
    nexusPage: "https://www.nexusmods.com/morrowind/mods/45468",
    nexusGameId: 1151,
    nexusModId: 45468,
    website: "https://github.com/MWSE/MWSE/releases",
    regex: /(download\/fose_[0-9]+_[0-9]+_[a-zA-Z0-9]+.7z)/i,
    latestVersion: '2.0.0'
  },
}


const getScriptExtenderVersion = (path : string): string => {
  // The exe versions appear to have a leading zero. So we need to cut it off. 
  let exeVersion = getVersion(path);
  exeVersion = exeVersion.startsWith("0") ? exeVersion.substr(exeVersion.indexOf('.'), exeVersion.length) : exeVersion;
  return semver.coerce(exeVersion).version || '-1';
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

function testScriptExtender(instructions, api) {
  const copies = instructions.filter(instruction => instruction.type === 'copy');
  const gameId = selectors.activeGameId(api.store.getState());
  const exeName = supportData[gameId].scriptExtExe;
  return new Promise((resolve, reject) => {
    return resolve(copies.find(file => path.basename(file.destination) === exeName) !== undefined);
  });
}

async function onCheckModVersion(api, gameId, mods) {
  if (!supportData[gameId]) return;
  const gameSupport = supportData[gameId];
  const gamePath = getGamePath(gameId, api);

  const scriptExtenderVersion : string = fs.statSync(path.join(gamePath, gameSupport.scriptExtExe)).size > 0 ? getScriptExtenderVersion(path.join(gamePath, gameSupport.scriptExtExe)) : '-1';
  if (scriptExtenderVersion === '-1') return;

  const modArray = Object.keys(mods).map(k => mods[k]);
  const scriptExtenders = modArray.filter(mod => mod.attributes.scriptExtender);
  const latestVersion = await checkForUpdate(api, gameSupport, scriptExtenderVersion);
  if (!latestVersion) return;

  scriptExtenders.forEach(xse => {
    if(xse.attributes.version !== latestVersion && xse.attributes.newestVersion !== latestVersion) {
      api.store.dispatch(actions.setModAttributes(gameId, xse.id, { newestFileId: "unknown", newestVersion: latestVersion }));
    }
  });
}

function onGameModeActivated(api, gameId: string) {
  // Clear script extender notifications from other games.
  api.dismissNotification('scriptextender');

  // If the game is unsupported, exit here. 
  if (!supportData[gameId]) return false;
  const gameSupport = supportData[gameId];

  // User has snoozed this notification, this clears each time Vortex is restarted (non-persistent)
  if (gameSupport.ignore && gameSupport.ignore === true) return false;

  //Get our game path.
  const activegame : types.IGame = util.getGame(gameId);
  const gamePath = getGamePath(activegame.id, api);

  // Grab our current script extender version. 
  const scriptExtenderVersion : string = fs.statSync(path.join(gamePath, gameSupport.scriptExtExe)).size > 0 ? getScriptExtenderVersion(path.join(gamePath, gameSupport.scriptExtExe)) : '-1';

  // If the script extender isn't installed, return. Perhaps we should recommend installing it?
  if (scriptExtenderVersion === '-1') {
    notifyNotInstalled(gameSupport, api);
    return false
  };

  // If we've already stored the latest version this session. 
  if (gameSupport.latestVersion) {
    return semver.lte(gameSupport.latestVersion, scriptExtenderVersion) ? null : notifyNewVersion(gameSupport.latestVersion, scriptExtenderVersion, supportData, api);
  };

  // Grab the script extender page to parse.
  checkForUpdate(api, gameSupport, scriptExtenderVersion);
}

function checkForUpdate(api, gameSupport, scriptExtenderVersion) {
  if (gameSupport.scriptExtExe === "MWSE.dll") return gameSupport.latestVersion; //Exit for Morrowind.
  return new Promise((resolve, reject) => {
    https.get(gameSupport.website, {protocol : 'https:'}, (res : IncomingMessage) => {
      const { statusCode } = res;
      if (statusCode !== 200) return resolve(gameSupport.latestVersion);
      res.setEncoding('utf8');
      let rawData = '';
      res.on('data', (chunk) => rawData += chunk);
      res.on('end', () => {
        // We just loaded the Script Extender Website website. Find our download link.
        const urlpath : string = rawData.match(gameSupport.regex)[0];
  
        // Remove the beta tag for the file name.
        const splitName : string[] = urlpath.split(path.sep);
  
        // Pop the last item in the array (file name)
        const downloadName : string = splitName.pop().toString();
  
        // We need to clean this up to make it semantic. By replacing underscores with dots, replacing double zeros with single zeros and removing leading zeros.
        // If we choose not to download directly, the regex can be adjusted to find the version in the text. 
        const newVersion : string = downloadName.match(/_([0-9]+_[0-9]+_[0-9]+)/i)[1].replace(/\_/g, '.').replace(/[0]+/g, '0').replace(/(0)[1-9]/g, (replacement) => replacement.replace('0',''));
  
        // If it's still not semantic, try coercing it.
        const latestVersion : string = semver.valid(newVersion) ? newVersion : semver.coerce(newVersion);
  
        // If it's STILL not valid, exit here. 
        if (!semver.valid(latestVersion)) return resolve(gameSupport.latestVersion);
        log('debug', 'Latest Version script extender', [gameSupport.name, latestVersion]);
  
        // Save this value so we don't have to check again this session. 
        gameSupport.latestVersion = latestVersion;
        
        // If the version from the website is greater than the installed version, inform the user. 
        if (semver.gt(latestVersion, scriptExtenderVersion)) notifyNewVersion(latestVersion, scriptExtenderVersion, gameSupport, api); //could send [gameSupport.website, urlpath] to allow downloads.
  
        return resolve(latestVersion);
      });
    }).on('error', (err: Error) => {
      log('error', 'Error getting script extender data', err);
      return resolve(gameSupport.latestVersion);
    });
  });
}

function notifyNewVersion(latest :string, current: string, supportData, api) { //could add url : string[], for the download URL
  //Raise a notification.
  api.sendNotification({
    type: 'info',
    id: 'scriptextender',
    allowSuppress: true,
    title: `Update for ${supportData.name}`,
    message: `Latest: ${latest}, Installed: ${current}`,
    actions: [ 
      { title : 'More', action: (dismiss: () => void) => 
        {
          api.showDialog('info', 'Script Extender Update', {
            text: `Vortex has detected a newer version of ${supportData.name} (${latest}) available to download from ${supportData.website}. You currently have version ${current} installed.`
            +'\nThe buttons below will open the script extender download page where you can download it directly into Vortex or through your browser. Please ensure you select the correct build for your game version. '
            +'\n\nIf you ignore this message, Vortex will not remind you again until you restart it.'
          }, [ 
              {
                label: 'Open in Vortex',
                action: () => {
                  // Open the script extender site in Vortex. 
                  api.store.dispatch(actions.showURL(supportData.website));
                  dismiss();
                }
              }, 
              {
                label: 'Open in browser',
                action: () => {
                  // Open the script extender site in Vortex. 
                  util.opn(supportData.website);
                  dismiss();
                }
              }, 
              {
                label: 'Ignore',
                action: () => {
                  // Ignore this update until Vortex is restarted.
                  supportData.ignore = true;
                  dismiss();
                }
              } 
            ])

        }
      } ]
  })
}

function notifyNotInstalled(supportData, api) {
  api.sendNotification({
    type: 'info',
    id: 'scriptextender',
    title: 'Script Extender not installed',
    allowSuppress: true,
    message: supportData.name,
    actions: [
      {
        title: 'More',
        action: (dismiss) => {
          api.showDialog('info', `${supportData.name} not found`, {
            text: `Vortex could not detect ${supportData.name}. This means it is either not installed or installed incorrectly.`
            +`\n\nFor the best modding experience, we recommend installing the script extender by visiting ${supportData.website}, Vortex can open the download page using the options below.`
            +'\n\nIf you ignore this notice, Vortex will not remind you again until it is restarted.'
          }, [
            {
              label: 'Open in Vortex',
              action: () => {
                api.store.dispatch(actions.showURL(supportData.website));
                dismiss();
              }
            },
            {
              label: 'Open in browser',
              action: () => {
                util.opn(supportData.website);
                dismiss();
              }
            },
            {
              label: 'Remind me next time',
              action: () => {
                supportData.ignore = true;
                dismiss();
              }
            }
          ])
        }
      }
    ]
  })
}

function testSupported(files : string[], gameId: string) : Promise<types.ISupportedResult> {
  return new Promise((resolve, reject) => {
    if (!supportData[gameId]) resolve({ supported: false, requiredFiles: [] }); //Not a script extender friendly game.
    const scriptExtender = files.find((file) => path.basename(file) === supportData[gameId].scriptExtExe);
    resolve({ supported: scriptExtender ? true : false, requiredFiles: [] });
  });
}

function installScriptExtender(context, files: string[], destinationPath: string, gameId: string) {
  // Install the script extender.
  const gameData = supportData[gameId];
  const scriptExtender = files.find(file => path.basename(file).toLowerCase() === gameData.scriptExtExe.toLowerCase());
  const idx = scriptExtender.indexOf(path.basename(scriptExtender));
  const rootPath = path.dirname(scriptExtender);

  const modId = path.basename(destinationPath, '.installing');
  const scriptExtenderVersion = getScriptExtenderVersion(path.join(destinationPath, scriptExtender));
  const modAtrributes = {
    allowRating: false,
    downloadGame: gameId,
    modId: gameData.nexusModId.toString(),
    logicalFileName: gameData.name,
    source: "nexus",
    version: scriptExtenderVersion,
    scriptExtender : true
  };
  context.api.store.dispatch(actions.setModAttributes(gameId, modId, modAtrributes));
  
  // Remove directories and anything that isn't in the rootPath.
  const filtered = files.filter(file => 
    ((file.indexOf(rootPath) !== -1) 
    && (!file.endsWith(path.sep))));

  const instructions = filtered.map(file => {
    return {
      type: 'copy',
      source: file,
      destination: path.join(file.substr(idx)),
    };
  });

  return Promise.resolve({ instructions });
}

function main(context: types.IExtensionContext) {
  context.registerInstaller('script-extender-installer', 10, testSupported, (files, destinationPath, gameId) => installScriptExtender(context, files, destinationPath, gameId));
  context.registerModType('script-extender', 10, (game) => supportData[game], (game: types.IGame) => getGamePath(game.id, context.api), (instructions) => testScriptExtender(instructions, context.api), {mergeMods: true});
  context.once(() => {
    context.api.events.on('gamemode-activated', async (gameId : string) => onGameModeActivated(context.api, gameId));
    context.api.events.on('check-mods-version', (gameId : string, mods : types.IMod[]) => onCheckModVersion(context.api, gameId, mods));
  });

  return true;
}

export default main;
