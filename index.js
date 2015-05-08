'use strict';

var babel = require('babel-core');
var t = babel.types;
var Transformer = babel.Transformer;

// TODO: Use UID to avoid name collision.
var ASSERT_NAME = 'assert';
var helper = require('babel-rtts-helper')(ASSERT_NAME);

// Make alias keys available in oridinary visitors.
// https://github.com/babel/babel/blob/master/src/babel/types/alias-keys.json
function applyAlias(visitor) {
  return Object.keys(visitor).reduce(function (acc, key) {
    var aliases = t.FLIPPED_ALIAS_KEYS[key];
    if (aliases) {
      aliases.forEach(function (alias) {
        acc[alias] = visitor[key];
      });
    } else {
      acc[key] = visitor[key];
    }
    return acc;
  }, {});
}

var functionVisitor = applyAlias({
  Function: {
    enter: function (node, parent, scope, injector) {
      injector.insertArgumentAssertion(node);
      injector.insertReturnAssertion(node, scope);
    }
  }
});

var returnVisitor = {
  ReturnStatement: {
    enter: function (node, parent, scope, state) {
      // Ignore inner functions.
      if (scope.getFunctionParent() !== state.scope) {
        return undefined;
      }
      var args = [
        node.argument || t.identifier('undefined'),
        helper.typeForAnnotation(state.annotation)
      ];
      var statement = t.returnStatement(
        t.callExpression(
          t.memberExpression(t.identifier(ASSERT_NAME), t.identifier('returnType')),
          args
        )
      );
      state.found = true;
      return statement;
    }
  }
};

function AssertionInjector(path, file) {
  this.node = path.node;
  this.parent = path.parent;
  this.scope = path.scope;

  this.path = path;
  this.file = file;

  this.injected = false;
}

AssertionInjector.prototype.run = function () {
  this.scope.traverse(this.node, functionVisitor, this);
  // TODO: `var foo: Foo = bar;` -> `var foo = assert.type(bar, Foo);`

  if (this.injected) {
    this.insertImport();
  }
};

AssertionInjector.prototype.insertImport = function () {
  var specifiers = [t.importSpecifier(t.identifier('assert'), t.identifier(ASSERT_NAME), '')];
  var declaration = t.importDeclaration(specifiers, t.literal('rtts_compiled.js'));
  this.node.body.unshift(declaration);
  // Update scope and path.
  this.path.setScope();
  this.path.checkSelf();
  // Because we added the new import declaration, we need to update local imports cache
  // so that assignments will be properly remapped by `file.moduleFormatter.remapAssignments()`.
  this.file.moduleFormatter.getLocalImports();
};

AssertionInjector.prototype.insertArgumentAssertion = function (func) {
  if (func.params.length === 0) {
    return;
  }
  var hasAnnotations = func.params.reduce(function (acc, param) {
    var identifier = param;
    if (param.type === 'AssignmentPattern') {
      // Default parameter.
      identifier = param.left;
    }
    return acc || !!identifier.typeAnnotation;
  }, false);
  if (!hasAnnotations) {
    return;
  }
  var args = func.params.reduce(function (acc, param) {
    var identifier = param;
    if (param.type === 'AssignmentPattern') {
      // Default parameter.
      identifier = param.left;
    }
    var annotation = identifier.typeAnnotation && identifier.typeAnnotation.typeAnnotation;
    var type = helper.typeForAnnotation(annotation);
    acc.push(identifier);
    acc.push(type);
    return acc;
  }, []);
  var statement = t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier(ASSERT_NAME), t.identifier('argumentTypes')),
      args
    )
  );
  func.body.body.unshift(statement);
  this.injected = true;
};

// TODO: Babel's parser doesn't support return type of arrow function.
AssertionInjector.prototype.insertReturnAssertion = function (func, scope) {
  if (!func.returnType) {
    return;
  }
  // Replace all returns in the very function scope.
  var annotation = func.returnType.typeAnnotation;
  var state = {
    scope: scope,
    annotation: annotation,
    found: false
  };
  scope.traverse(func, returnVisitor, state);
  if (state.found) {
    this.injected = true;
  } else {
    // TODO: Warn if return doesn't exist in the function.
  }
};

module.exports = new Transformer('type-assertion', {
  Program: {
    enter: function (node, parent, scope, file) {
      new AssertionInjector(this, file).run();
    }
  }
});
