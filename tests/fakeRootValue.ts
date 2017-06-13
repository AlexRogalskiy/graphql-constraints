import {
  buildSchema,
  Source,
  GraphQLSchema,
  GraphQLObjectType,
  isAbstractType,
  GraphQLScalarType,
  GraphQLOutputType,
  GraphQLNonNull,
  GraphQLList,
} from 'graphql';

import { mapValues } from 'lodash';

const defaultValues = {
  'Int': 0,
  'Float': 0,
  'String': 'String Value',
  'Boolean': false,
  'ID': 'ID'
};

export function fakeRootValue(idl: string|Source):any {
  const schema = buildSchema(idl);
  return fakeType(schema.getQueryType(), schema);
}

function fakeType(type: GraphQLOutputType, schema: GraphQLSchema) {
  if (type instanceof GraphQLNonNull) {
    return fakeType(type.ofType, schema)
  }
  if (type instanceof GraphQLList) {
    return [fakeType(type.ofType, schema), fakeType(type.ofType, schema)]
  }
  if (isAbstractType(type)) {
    const possibleTypes = schema.getPossibleTypes(type);
    return fakeType(possibleTypes[0], schema);
  }

  if (type instanceof GraphQLObjectType) {
    const fields = type.getFields();
    return mapValues(fields, field => {
      return fakeType(field.type, schema);
    })
  }

  if (type instanceof GraphQLScalarType) {
    return defaultValues[type.name] || `<${type.name}>`;
  }
}
