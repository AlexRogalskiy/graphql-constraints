import {
  Source,
  parse,
  concatAST,
  buildASTSchema,
  defaultFieldResolver,
  GraphQLSchema,
  getNamedType,
  GraphQLScalarType,
  GraphQLObjectType,
  DirectiveNode,
  ScalarTypeDefinitionNode,
  InputValueDefinitionNode,
} from 'graphql';

import { getArgumentValues } from 'graphql/execution/values.js';

import { each, keyBy, mapValues, mergeWith } from 'lodash';


type Dictionary<T> = {[key: string]: T};

interface ASTNodeWithDirectives {
  directives?: DirectiveNode[];
}

interface StringConstraints {
  minLength: number;
  maxLength: number;
  startsWith: string;
  endsWith: string;
}

interface NumberConstraints {
  min: number;
  max: number;
}

interface BooleanConstraints {
  equals: boolean;
}

interface ConstraintsMap {
  '@stringValue'?: StringConstraints[];
  '@numberValue'?: NumberConstraints[];
  '@booleanValue'?: BooleanConstraints[];
}

export const constraintsIDL = new Source(`
directive @numberValue(
  min: Float
  max: Float
) on FIELD | QUERY

directive @stringValue(
  minLength: Int
  maxLength: Int
  startsWith: String
  endsWith: String
) on FIELD | QUERY
`, 'constraintsIDL');

const constraintsDirectives = getDirectivesFromAST(constraintsIDL);

function getDirectivesFromAST(idl:Source) {
  const dummyIDL = `
    type Query {
      dummy: String
    }
  `;
  const fullAST = concatAST([parse(idl), parse(dummyIDL)]);
  const schema = buildASTSchema(fullAST);

  const directives = keyBy(schema.getDirectives(), 'name');
  delete directives.skip;
  delete directives.include;
  delete directives.deprecated;

  return directives;
}

function extractConstraints(astNode: ASTNodeWithDirectives):ConstraintsMap {
  if (astNode === null)
    return {};
  let result = {};
  astNode.directives.forEach(directiveNode => {
    const name = directiveNode.name.value;
    const directive = constraintsDirectives[name];
    const constraints = getArgumentValues(directive, directiveNode);
    result['@' + name] = Object.keys(constraints).length ? [constraints] : [];
  });
  return result;
}

function typeOf(value: any): string {
  if (value == null)
    return 'null';

  let type = value.constructor && value.constructor.name;
  // handle objects created with Object.create(null)
  if (!type && (typeof value === 'object'))
    type = 'object';
  return type.toLowerCase();
}

function validate(value: any, directives:ConstraintsMap): void {
  if (Object.keys(directives).length === 0)
    return;

  const valueType = typeOf(value);
  if (valueType === 'null') {
    return;
  } else if (valueType === 'array') {
    return value.forEach(item => validate(item, directives));
  } else if(valueType === 'object') {
    // TODO
  } else {
    const expectedDirective = `@${valueType}Value`;
    const validateFn = {
      string: stringValue,
      number: numberValue,
      boolean: booleanValue,
    } [valueType];

    const directiveNames = Object.keys(directives);
    // we got
    if (!directiveNames.includes(expectedDirective)) {
      const allowedTypes = directiveNames.map(
        name => /@(.+)Value/.exec(name)[1]
      );
      throw Error(`Got ${valueType} expected ${allowedTypes.join(',')}`)
    }

    for (let directive of directives[expectedDirective]) {
      validateFn(value, directive);
    }
  }
}

function stringValue(str:string, constraints: StringConstraints) {
  if (constraints.minLength != null && str.length < constraints.minLength)
    throw Error('Less than minLength');
  if (constraints.maxLength != null && str.length > constraints.maxLength)
    throw Error('Greater than maxLength');
  if (constraints.startsWith != null && !str.startsWith(constraints.startsWith))
    throw Error(`Doesn\'t start with ${constraints.startsWith}`);
  if (constraints.endsWith != null && !str.endsWith(constraints.endsWith))
    throw Error(`Doesn\'t end with ${constraints.endsWith}`);
}

function numberValue(num:number, constraints: NumberConstraints) {
  if (constraints.min != null && num < constraints.min)
    throw Error('Less than min');
  if (constraints.max != null && num > constraints.max)
    throw Error('Greater than max');
}

function booleanValue(value:boolean, constraints: BooleanConstraints) {
  if (constraints.equals != null && value !== constraints.equals)
    throw Error('not equals');
}

function extractScalarConstraints(schema: GraphQLSchema): Dictionary<ConstraintsMap> {
  let res = {};
  Object.values(schema.getTypeMap()).forEach(type => {
    if (type instanceof GraphQLScalarType) {
      const astNode = (type as any).astNode as ScalarTypeDefinitionNode;
      res[type.name] = extractConstraints(astNode);
    }
  });
  return res;
}

function mergeConstraints(obj:ConstraintsMap, source:ConstraintsMap) {
  return mergeWith(
    obj, source, (obj, src) => obj && obj.concat(src) || src
  );
}

export function constraintsMiddleware(schema: GraphQLSchema):void {
  let scalarConstraints = extractScalarConstraints(schema);

  Object.values(schema.getTypeMap()).forEach(type => {
    if (type.name.startsWith('__'))
      return;

    if (type instanceof GraphQLScalarType) {
      return;
    }

    if (type instanceof GraphQLObjectType) {
      each(type.getFields(), field => {
        const argsConstraints = mapValues(keyBy(field.args, 'name'), arg => {
          const astNode = (arg as any).astNode as InputValueDefinitionNode;
          return mergeConstraints(
            extractConstraints(astNode),
            scalarConstraints[getNamedType(arg.type).name]
          );
        });

        const orginalResolve = field.resolve || defaultFieldResolver;
        field.resolve = (source, args, context, info) => {
          each(args, (value, name) => {
            validate(value, argsConstraints[name]);
          });
          return orginalResolve(source, args, context, info);
        };
      });
    }
  });
}
