var nats = require('nats').connect();
var fs = require('fs');
var recursive = require('recursive-readdir');

// Simple Publisher 
function readFiles(dirname, onFileContent, onError) {
  var result = {};
  var components = [];
  var comp;
  recursive(dirname, function (err, files) {
    files.forEach((file, index, array) => {
      fs.readFile(file, (err, data) => {
        var compName;
        if (err){console.log(err);}
        file = file.replace(dirname.substring(2, dirname.length), '');
        if (file.indexOf('engine.yml') !== -1){
          result['engine_yml'] = data.toString();
        }
        else if(file.indexOf('components') !== -1) {
          compName = file.substring(file.indexOf('/') + 1);
          compName = compName.substring(0, compName.indexOf('/'));
          comp = {};
          comp.name = compName;
          comp.data = data.toString();
          components.push(comp);
        }
        if (index === array.length-1) {
          result.components = components;
          onFileContent(result);
        }
      });
    });
  });
}

readFiles('./engine_sample/', 
  function(result){
    nats.publish('foo', JSON.stringify(result));
  }, 
  function(err){console.log(err);});
