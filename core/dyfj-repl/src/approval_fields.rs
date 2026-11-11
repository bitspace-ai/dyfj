pub use crate::approval::visible;
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::fmt;

// Keep received object entries, including duplicate keys, in their original order.
pub enum FieldValue {
    Scalar(Value),
    Array(Vec<FieldValue>),
    Object(Vec<(String, FieldValue)>),
}

impl<'de> Deserialize<'de> for FieldValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldVisitor;
        impl<'de> Visitor<'de> for FieldVisitor {
            type Value = FieldValue;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(FieldValue::Scalar(Value::Null))
            }
            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(FieldValue::Scalar(value.into()))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(FieldValue::Scalar(value.into()))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(FieldValue::Scalar(value.into()))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
                Ok(FieldValue::Scalar(value.into()))
            }
            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(FieldValue::Scalar(value.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element()? {
                    values.push(value);
                }
                Ok(FieldValue::Array(values))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut fields = Vec::new();
                while let Some(field) = map.next_entry()? {
                    fields.push(field);
                }
                Ok(FieldValue::Object(fields))
            }
        }
        deserializer.deserialize_any(FieldVisitor)
    }
}

impl Serialize for FieldValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Scalar(value) => value.serialize(serializer),
            Self::Array(values) => values.serialize(serializer),
            Self::Object(fields) => {
                let mut map = serializer.serialize_map(Some(fields.len()))?;
                for (key, value) in fields {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

pub fn field(key: &str, text: &str) -> String {
    let mut lines = text.split('\n');
    let mut rendered = format!("   · {}: {}\n", visible(key), visible(lines.next().unwrap_or_default()));
    for line in lines {
        rendered.push_str(&format!("   | {}\n", visible(line)));
    }
    rendered
}

pub fn render_fields(value: &FieldValue) -> Option<String> {
    let FieldValue::Object(fields) = value else { return None };
    let mut rendered = String::new();
    for (key, value) in fields {
        let text = match value {
            FieldValue::Scalar(Value::String(text)) => text.clone(),
            _ => serde_json::to_string(value).expect("JSON field value serializes"),
        };
        rendered.push_str(&field(key, &text));
    }
    Some(rendered)
}
