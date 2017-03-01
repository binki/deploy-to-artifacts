#!/usr/bin/env node
'use strict';

const crossSpawn = require('cross-spawn');
const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const request = require('request');
const rimraf = require('rimraf-noglob');
const xml2js = require('xml2js');

rimraf('build/staging', (ex) => {
  mkdirp('build/staging', (ex) => {
    request('https://faito-artifacts.s3.amazonaws.com/?list-type=2', (ex, message, body) => {
      xml2js.parseString(body, (ex, o) => {
        const groups = [];
        for (const content of o.ListBucketResult.Contents) {
          const key = content.Key[0];
          const index = parseInt(/^[^/]*\/[^/]*\/([^/]*)/.exec(key)[1], 10);
          if (isNaN(index)) {
            continue;
          }
          const group = groups[index] = groups[index] || [];
          group.push(key);
        }

        const chosenGroup = groups[groups.length - 1];
        console.log(chosenGroup);

        // Download all things from thing to staging directory.
        let remainingRequests = 0;
        const futureMoves = [];
        for (const entry of chosenGroup) {
          // Ignore directories themselves… ;-)
          if (/\/$/.test(entry)) {
            console.log(`skipping directory ${entry}`);
            continue;
          }
          // TODO: Support subdirectories in build/ directory
          const entryRelativePath = entry.split('/').slice(3).join('/');
          const tempDest = path.join('build', 'staging', entryRelativePath);
          futureMoves.push({
            from: tempDest,
            to: path.join('build', entryRelativePath),
          });
          console.log(entryRelativePath);
          remainingRequests++;
          const currentRequest = request('https://faito-artifacts.s3.amazonaws.com/' + entry);
          currentRequest.pipe(fs.createWriteStream(tempDest));
          currentRequest.on('end', () => {
            if (!--remainingRequests) {
              // After last download.
              console.log('downloaded', futureMoves);

              crossSpawn('git', ['fetch'])
                .on('close', code => {
                  if (code != 0) {
                    throw new Error(`git exited with ${code}`);
                  }
                  // Now load git rev to checkout.
                  new Promise((resolve, reject) => fs.readFile(path.join('build', 'staging', 'git-rev.json'), (ex, data) => ex ? reject(ex) : resolve(data))).then(revData => {
                    return JSON.parse(revData);
                  }).then(rev => {
                    console.log(rev);
                    crossSpawn('git', ['checkout', rev])
                      .on('close', () => {
                        return Promise.all(futureMoves.map(futureMove => {
                          return new Promise((resolve, reject) => fs.rename(futureMove.from, futureMove.to, (ex) => ex ? reject(ex) : resolve()));
                        })).then(() => {
                          return new Promise((resolve, reject) => {
                            crossSpawn('sh', ['-c', 'npm install && npm prune'])
                              .on('close', resolve)
                              .on('error', reject)
                            ;
                          }).then(code => {
                            if (!code) {
                              throw new Error(`Stuff died with ${code}`);
                            }
                          });
                        });
                      })
                    ;
                  });
                })
              ;
            }
          });
        }
      });
    });
  });
});
