import * as https from 'https';
import * as _ from 'lodash';
import * as semver from 'semver';
import * as url from 'url';

import { log, selectors, types, util } from 'vortex-api';

import { ignoreNotifications } from './index';
import { IGameSupport } from './types';

import { IncomingHttpHeaders, IncomingMessage } from 'http';

function query(baseUrl: string, request: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const getRequest = getRequestOptions(`${baseUrl}/${request}`);
    https.get(getRequest, (res: IncomingMessage) => {
      res.setEncoding('utf-8');
      const msgHeaders: IncomingHttpHeaders = res.headers;
      const callsRemaining = parseInt(util.getSafe(msgHeaders, ['x-ratelimit-remaining'], '0'), 10);
      if ((res.statusCode === 403) && (callsRemaining === 0)) {
        const resetDate = parseInt(util.getSafe(msgHeaders, ['x-ratelimit-reset'], '0'), 10);
        log('info', 'GitHub rate limit exceeded',
          { reset_at: (new Date(resetDate)).toString() });
        return reject(new util.ProcessCanceled('GitHub rate limit exceeded'));
      }

      let output: string = '';
      res
        .on('data', data => output += data)
        .on('end', () => {
          try {
            return resolve(JSON.parse(output));
          } catch (parseErr) {
            return reject(parseErr);
          }
        });
    })
      .on('error', err => {
        return reject(err);
      })
      .end();
  });
}

function getRequestOptions(link) {
  const relUrl = url.parse(link);
  return ({
    ..._.pick(relUrl, ['port', 'hostname', 'path']),
    headers: {
      'User-Agent': 'Vortex',
    },
  });
}

async function downloadConsent(api: types.IExtensionApi,
                               gameSupport: IGameSupport, gameId: string) {
  return new Promise((resolve, reject) => {
    api.sendNotification({
      id: `scriptextender-missing-${gameId}`,
      type: 'info',
      allowSuppress: true,
      title: 'Script Extender not installed',
      message: gameSupport.name,
      actions: [
        {
          title: 'More',
          action: (dismiss) => {
            api.showDialog('info', `${gameSupport.name} not found`, {
              text: 'Vortex could not detect {{name}}. This means it is either not installed or installed incorrectly.'
              + '\n\nFor the best modding experience, we recommend downloading and installing the script extender.'
              + '\n\nIf you ignore this notice, Vortex will not remind you again until it is restarted.',
              parameters: { name: gameSupport.name },
            }, [
              {
                label: 'Remind me next time',
                action: () => {
                  ignoreNotifications(gameSupport);
                  return reject(new util.UserCanceled());
                },
              },
              {
                label: 'Download',
                action: () => {
                  resolve();
                  dismiss();
                },
              },
            ]);
          },
        }],
    });
  });
}

async function notifyUpdate(api: types.IExtensionApi, gameSupport: IGameSupport,
                            latest: string, current: string) {
  const gameId = selectors.activeGameId(api.store.getState());
  const t = api.translate;
  return new Promise((resolve, reject) => {
    api.sendNotification({
      type: 'info',
      id: `scriptextender-update-${gameId}`,
      allowSuppress: true,
      title: 'Update for {{name}}',
      message: 'Latest: {{latest}}, Installed: {{current}}',
      replace: {
        name: gameSupport.name,
        latest,
        current,
      },
      actions: [
        { title : 'More', action: (dismiss: () => void) => {
            api.showDialog('info', 'Script Extender Update', {
              text: 'Vortex has detected a newer version of {{name}} ({{latest}}) available to download from {{website}}. You currently have version {{current}} installed.'
              + '\nVortex can download and attempt to install the new update for you.'
              + '\n\nIf you ignore this message, Vortex will not remind you again until you restart it.',
              parameters: {
                name: gameSupport.name,
                latest,
                website: gameSupport.website,
                current,
              },
            }, [
                {
                  label: 'Ignore',
                  action: () => {
                    // Ignore this update until Vortex is restarted.
                    ignoreNotifications(gameSupport);
                    reject(new util.UserCanceled());
                    dismiss();
                  },
                },
                {
                  label: 'Download',
                  action: () => {
                    resolve();
                    dismiss();
                  },
                },
              ]);
          },
        } ],
    });
  });
}

export async function getLatestReleases(gameSupport: IGameSupport) {
  if (!!gameSupport?.gitHubAPIUrl) {
    return query(gameSupport.gitHubAPIUrl, 'releases')
    .then((releases) => {
      if (!Array.isArray(releases)) {
        return Promise.reject(new util.DataInvalid('expected array of github releases'));
      }
      // TODO: Right now we can only download NVSE through Github and
      //  it appears we can pull the trimmed release version through the tag_name
      //  property; hopefully this will remain consistent but we may have to enhance
      //  this function in the future to function on a per-script-extender basis.
      const current = releases
        .filter(rel => {
          const tagName = util.getSafe(rel, ['tag_name'], undefined);
          const isPreRelease = util.getSafe(rel, ['prerelease'], false);
          const version = semver.valid(tagName);

          return (!isPreRelease
            && (version !== null)
            && semver.gte(version, gameSupport.latestVersion));
        })
        .sort((lhs, rhs) => semver.compare(rhs.tag_name, lhs.tag_name));

      return Promise.resolve(current);
    });
  }
}

export async function checkForUpdates(api: types.IExtensionApi,
                                      gameSupport: IGameSupport,
                                      currentVersion: string): Promise<string> {
  const state = api.store.getState();
  const gameId = selectors.activeGameId(state);
  return getLatestReleases(gameSupport)
    .then(async currentRelease => {
      const mostRecentVersion = currentRelease[0].tag_name;
      const archives = currentRelease[0].assets.filter(asset => {
        const beta = `beta/${asset.name}`;
        const down = `download/${asset.name}`;
        return beta.match(gameSupport.regex) || down.match(gameSupport.regex);
      });

      const downloadLink = archives[0]?.browser_download_url;
      if (downloadLink === undefined) {
        return Promise.reject(new util.DataInvalid('Failed to resolve browser download url'));
      }
      const download = async () => {
        const redirectionURL = await new Promise((resolve, reject) => {
          https.request(getRequestOptions(downloadLink), res => {
            return resolve(res.headers['location']);
          })
            .on('error', err => reject(err))
            .end();
        });
        const dlInfo = {
          game: gameId,
          name: gameSupport.name,
        };
        api.events.emit('start-download', [redirectionURL], dlInfo, undefined,
          (error, id) => {
            if (error !== null) {
              if ((error.name === 'AlreadyDownloaded')
                  && (error.downloadId !== undefined)) {
                id = error.downloadId;
              } else {
                api.showErrorNotification('Download failed',
                  error, { allowReport: false });
                return;
              }
            }
            api.events.emit('start-install-download', id, true, (err, modId) => {
              if (err !== null) {
                api.showErrorNotification('Failed to install script extender',
                  err, { allowReport: false });
              }
            });
          }, 'never');
      };

      if (semver.valid(mostRecentVersion) === null) {
        return Promise.resolve(currentVersion);
      } else {
        if (semver.gt(mostRecentVersion, currentVersion)) {
          return notifyUpdate(api, gameSupport, mostRecentVersion, currentVersion)
            .then(() => download())
            .then(() => Promise.resolve(mostRecentVersion));
        } else {
          return Promise.resolve(currentVersion);
        }
      }
    }).catch(err => {
      if (err instanceof util.UserCanceled || err instanceof util.ProcessCanceled) {
        return Promise.resolve(currentVersion);
      }

      api.showErrorNotification('Unable to update script extender', err);
      return Promise.resolve(currentVersion);
    });
}

export async function downloadScriptExtender(api: types.IExtensionApi,
                                             gameSupport: IGameSupport) {
  const state = api.store.getState();
  const gameId = selectors.activeGameId(state);
  if (gameSupport?.gitHubAPIUrl === undefined) {
    return Promise.reject(new util.ArgumentInvalid('Game entry invalid or missing gitHubUrl'));
  }

  let mostRecentVersion;
  return getLatestReleases(gameSupport)
    .then(async currentRelease => {
      mostRecentVersion = currentRelease[0].tag_name;
      const archives = currentRelease[0].assets.filter(asset => {
        const beta = `beta/${asset.name}`;
        const down = `download/${asset.name}`;
        return beta.match(gameSupport.regex) || down.match(gameSupport.regex);
      });

      const downloadLink = archives[0]?.browser_download_url;
      if (downloadLink === undefined) {
        return Promise.reject(new util.DataInvalid('Failed to resolve browser download url'));
      }

      const download = async () => {
        const redirectionURL = await new Promise((resolve, reject) => {
          https.request(getRequestOptions(downloadLink), res => {
            return resolve(res.headers['location']);
          })
            .on('error', err => reject(err))
            .end();
        });
        const dlInfo = {
          game: gameId,
          name: gameSupport.name,
        };
        api.events.emit('start-download', [redirectionURL], dlInfo, undefined,
          (error, id) => {
            if (error !== null) {
              if ((error.name === 'AlreadyDownloaded')
                  && (error.downloadId !== undefined)) {
                id = error.downloadId;
              } else {
                api.showErrorNotification('Download failed',
                  error, { allowReport: false });
                return;
              }
            }
            api.events.emit('start-install-download', id, true, (err, modId) => {
              if (err !== null) {
                api.showErrorNotification('Failed to install script extender',
                  err, { allowReport: false });
              }
            });
          }, 'never');
      };

      return downloadConsent(api, gameSupport, gameId)
        .then(() => download());
    })
    .catch(err => {
      if (err instanceof util.UserCanceled || err instanceof util.ProcessCanceled) {
        return Promise.resolve();
      } else {
        api.showErrorNotification('Unable to download/install script extender', err);
        return Promise.resolve();
      }
    });
}
