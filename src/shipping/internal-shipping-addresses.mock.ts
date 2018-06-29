import { InternalAddress } from '../address';
import { getCart } from '../cart/internal-carts.mock';
import { getQuote } from '../quote/internal-quotes.mock';

import { getShippingOptions } from './internal-shipping-options.mock';

export function getShippingAddress(): InternalAddress {
    return {
        id: '55c96cda6f04c',
        firstName: 'Test',
        lastName: 'Tester',
        company: 'Bigcommerce',
        addressLine1: '12345 Testing Way',
        addressLine2: '',
        city: 'Some City',
        province: 'California',
        provinceCode: 'CA',
        postCode: '95555',
        country: 'United States',
        countryCode: 'US',
        phone: '555-555-5555',
        customFields: [],
    };
}

export function getShippingAddressResponseBody() {
    return {
        data: {
            quote: getQuote(),
            cart: getCart(),
            shippingAddress: getShippingAddress(),
            shippingOptions: getShippingOptions(),
        },
    };
}